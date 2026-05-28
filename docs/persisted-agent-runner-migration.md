# PersistedAgentRunner Migration — Final Plan (Form C-1)

> Status: **completed**. Implementation summary in §13 (Final state).
> Audience: engineers reading this doc to understand the migration history
> Related: `docs/runner-events.md`, `docs/runner.md`, `docs/threadid-lifecycle.md`,
> `docs/architecture.md` (CopilotKit integration)

## 1. Background

History-replay bugs after server restart traced to a single root cause: CopilotKit's
default `InMemoryAgentRunner` keeps all thread state in process memory
(`GLOBAL_STORE`). After restart, `/connect` returns an empty SSE stream for any
historical thread; client-side patches (`useThreadHydration` + setMessages) race
with CopilotKit's protocol state machine and lose.

Three observable symptoms after restart:

- Chat messages flash briefly then the panel goes blank
- Last user message gets re-sent (LLM runs again, burns tokens)
- Frontend-tool cards stuck in `inProgress` state (no "View in Outcomes" link)

This document specifies the migration to a database-backed
`PersistedAgentRunner` using CopilotKit's official extension point
(`CopilotSseRuntimeOptions.runner?: AgentRunner`).

## 2. Decision: Form C-1

Four forms were considered. C-1 chosen for the best risk/reward balance.

| Form  | Description                                                                                                                 | Verdict     |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| A     | `PersistingAgent` stays at Agent layer (write); `PersistedAgentRunner` only handles `connect()` (read)                      | Rejected: persistence split across two layers; outer code must manage both |
| B     | `PersistedAgentRunner` fully replaces `InMemoryAgentRunner` (run + connect + pub/sub) — no `InMemoryAgentRunner` dependency | Rejected: requires reimplementing ~200 lines of pub/sub + finalize + isRunning + multi-subscriber semantics; CopilotKit version coupling risk |
| **C-1** | `PersistedAgentRunner` wraps `InMemoryAgentRunner`; persistence handled inside the runner via `PersistingAgent` wrapping the inner agent | **Chosen** — single configuration point; reuses proven components; minimum new code |
| C-2   | Like C-1 but actively purges `GLOBAL_STORE` on run completion                                                               | Deferred: requires hacking CopilotKit internals; not needed for V1 |

### Why C-1

1. **Single configuration point**: callers (`runner.ts`, `runtime.server.ts`)
   construct one `PersistedAgentRunner` instance. No external `PersistingAgent`
   wrapping. `PersistingAgent` becomes an internal implementation detail of the
   runner.
2. **Reuses proven infrastructure**: `InMemoryAgentRunner`'s pub/sub
   (multi-subscriber, late-joiner replay, stop/abort, finalize) is well-tested
   in CopilotKit. We don't reimplement it.
3. **Reuses `PersistingAgent`**: the event-coalescing logic (TEXT_MESSAGE_*
   streaming → single `message` row; TOOL_CALL_START/ARGS/END → single
   `tool_call_chunk` row; finalize idempotency) keeps working as-is.
4. **Bounded memory cost**: see §5.

## 3. Architecture

### 3.1 High-level flow

```
backend agent path (runChatRequest):
    HttpAgent / Bridge → CopilotRuntime(runner: PersistedAgentRunner)
                                              │
                                              └─→ run/connect

built-in agent path (runBuiltinChatRequest):
    BuiltInAgent → CopilotSseRuntime(runner: PersistedAgentRunner)
                                              │
                                              └─→ run/connect

Both paths converge at the SAME runner type — one place to plug DB-backed
persistence + read.
```

### 3.2 Inside PersistedAgentRunner

```
PersistedAgentRunner (per-request)
├─ run(req):                              [WRITE path]
│   wrapped = new PersistingAgent({ inner: req.agent, runId, startSeq })
│   return InMemoryAgentRunner.run({ ...req, agent: wrapped })
│
├─ connect(req):                          [READ path]
│   if (InMemoryAgentRunner.isRunning(req)):
│       return InMemoryAgentRunner.connect(req)    // live tail in-process
│   else:
│       return reconstructFromDb({ threadId, ownerId })
│
├─ isRunning(req): delegate
└─ stop(req):      delegate
```

### 3.3 The `reconstructFromDb` event reconstructor

Reverses what `PersistingAgent` does (one DB row → 1–N AG-UI events):

| DB row `type`         | Produced AG-UI events                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| `message`             | `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` + `TEXT_MESSAGE_END`             |
| `tool_call_chunk`     | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END`                         |
| `tool_call_result`    | `TOOL_CALL_RESULT`                                                             |
| `reasoning`           | `REASONING_START` + `REASONING_MESSAGE_START` + `REASONING_MESSAGE_CONTENT` + `REASONING_MESSAGE_END` + `REASONING_END` |
| `error`               | `RUN_ERROR`                                                                    |
| `started` / `finished`† | Suppressed (we wrap each run with our own `RUN_STARTED` / `RUN_FINISHED`)    |
| `degraded`†           | Suppressed (admin-only, not user-visible chat events)                          |
| `workflow_node_*`†    | Suppressed (workflow forensics, not chat events)                               |

† Naming as of today; the original migration doc used `final` and
`capability_degraded`. The DB column is plain text so the rename
was a code-level union change with no schema impact. The
`workflow_node_*` row entirely post-dates this migration (D4a).

**Wrapping**: each run emits `RUN_STARTED` (without `input`) at the start and
`RUN_FINISHED` at the end. Omitting `input` is intentional — see §6.4.

**Synthesis for missing TOOL_CALL_RESULT**: see §3.4.

### 3.4 Synthetic tool result

For every `tool_call_chunk` row that has no matching `tool_call_result` row in
the same run, the reconstructor emits a synthetic `TOOL_CALL_RESULT` event
immediately after the chunk's `TOOL_CALL_END`. Per-tool semantics:

```ts
function synthesizeToolCallResult(payload, runStatus): ToolCallResultEvent {
  // Failed/cancelled run: explicit failure envelope.
  if (runStatus !== "succeeded") {
    return { ..., content: JSON.stringify({ ok: false, error: "synthetic_run_aborted" }) };
  }
  // Per-tool reconstruction: only for tools whose result carries an
  // identifier the LLM references in subsequent turns (e.g. "update the
  // sales-pie chart"). Add a case here only when this criterion applies.
  if (payload.toolName === "render_chart") {
    const args = safeParseArgs(payload.args);
    if (typeof args?.chartId === "string") {
      return { ..., content: JSON.stringify({ ok: true, chartId: args.chartId }) };
    }
  }
  // Generic fallback. Sufficient for tools whose result is "fire-and-forget"
  // from the LLM's perspective.
  return { ..., content: JSON.stringify({ ok: true }) };
}
```

**Why this is necessary**: AI SDK does not emit `tool-result` parts for tools
without an `execute()` function (i.e. frontend tools). Therefore
`TOOL_CALL_RESULT` events never enter the AG-UI stream and never get persisted
for frontend tools. The CopilotKit client tracks completion locally during the
live run, but after restart that local state is gone — the reconstructed
stream is the only source. Synthesis fills the gap.

**Verified empirically**: queried `entity_run_event` for a render_chart run —
DB shows `started → tool_call_chunk(render_chart) → final` with no
`tool_call_result` row. Backend agents (mastra/dify) emit `TOOL_CALL_RESULT`
explicitly in their bridge code (`chat.server.ts`), so the synthesis branch
never fires for them.

## 4. Files

### 4.1 New

**`src/lib/copilot/persisted-agent-runner.ts`** (~90 lines)

The runner class. Per-request construction. Uses `switchMap` (not `defer +
mergeAll`) for the async `isRunning` branch — see reviewer A's note.

**`src/lib/copilot/event-reconstruction.ts`** (~280 lines)

DB → AG-UI event reconstructor as an async generator wrapped by `from(...)`.

### 4.2 Modified

**`src/lib/copilot/index.server.ts`** — re-export the AgentRunner abstract
class and request types (currently missing):

```ts
export {
  AgentRunner,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
export type {
  AgentRunnerRunRequest,
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
```

**`src/lib/runner/runner.ts`** (built-in path, two construction sites):

- Remove outer `new PersistingAgent({ inner: targetAgent, runId, startSeq })`.
  Pass `targetAgent` directly.
- Construct `PersistedAgentRunner` if the flag is on, pass to runtime.
- Leave bookkeeping path (stub runtime, `classified === null`) unchanged —
  no `entity_run` is created there, so no runner needed.

```ts
const runner = process.env.NANGO_RUNNER_BACKEND === "db"
  ? new PersistedAgentRunner({ ownerId: userId, runId: run.id, startSeq, log: requestLog })
  : undefined;  // fall back to default InMemoryAgentRunner

const runtime = new CopilotSseRuntime({
  agents,
  ...(runner ? { runner } : {}),
});
```

**`src/lib/backends/runtime.server.ts`** (backend path):

- Add `runner?: AgentRunner` to `ChatContext` (per reviewer B — cleaner than
  changing `runWithAgents`'s function signature).
- Inside `runWithAgents`, thread `ctx.runner` into `new CopilotRuntime({ agents,
  runner })`.

**`src/lib/backends/types.ts`** (or wherever `ChatContext` lives):

```ts
interface ChatContext {
  // ... existing fields
  runner?: AgentRunner;  // optional; set by run path, not bookkeeping
}
```

**`src/lib/runner/runner.ts`** (backend path call site, `runChatRequest`):

- Remove outer `new PersistingAgent({ inner: innerAgent, runId })`.
- Construct `PersistedAgentRunner` if flag on, pass via `ctx.runner`:

```ts
const runner = process.env.NANGO_RUNNER_BACKEND === "db"
  ? new PersistedAgentRunner({ ownerId: input.ownerId, runId: run.id, log })
  : undefined;
const ctx = { ...existing, runner };
return runWithAgents(request, { agents: { [ctx.agentId]: innerAgent }, /* … */ });
```

**`src/components/right-panels/ChatPanel.tsx`** — remove the
`useThreadHydration(agentId, threadId)` call and its import.

**`src/components/right-panels/ChartPreviewCard.tsx`** — revert the
`isCompletedReplay` discriminator and `SuccessCard` extraction added in
commit `5fab519`. The history-replay UI fallback is no longer needed: with
`PersistedAgentRunner.connect()` driving the SSE stream, CopilotKit observes
the tool call as `complete` and renders the full card naturally.

### 4.3 Deleted

- `src/hooks/useThreadHydration.ts` — no remaining consumers.

### 4.4 Kept

- `src/app/api/threads/[threadId]/messages/route.ts` — no production
  consumer after `useThreadHydration` removal, but kept for admin debugging /
  future export tooling. Add doc comment: "V2+: no production consumer; kept
  for admin and export use cases".

## 5. Known limitation: GLOBAL_STORE accumulation

C-1 delegates `run()` to `InMemoryAgentRunner`, which keeps run events in
`GLOBAL_STORE.historicRuns` for the lifetime of the process. After our
migration, this memory is no longer functionally consumed by replay
(`PersistedAgentRunner.connect()` reads from DB when no active run exists)
but still accumulates per run.

Sizing estimate for Nango's target deployment ("single long-running Node
process, personal / small-team multi-tenant" per AGENTS.md):

- ~10–100 events per run, ~200B average payload (large `render_chart`
  options pushed to ~10–64KB)
- 50 runs/day × 30 days × ~5KB avg = ~7.5 MB per user
- 10 users → ~75 MB; 100 users → ~750 MB

**Acceptable for V1**. Single-node Nango deployments operating in this size
range will not see OOM pressure. If monitoring reports memory pressure later,
upgrade to C-2 (active `GLOBAL_STORE` purge after run finalization) or B
(full reimplementation). The upgrade is local to `PersistedAgentRunner`
internals; no external API change.

This limitation is documented at the top of `persisted-agent-runner.ts` so
future maintainers know the upgrade path.

## 6. Reviewer-driven clarifications

### 6.1 Why use PersistingAgent inside, not write directly via `onEvent`

Both observe the same events (verified via `@ag-ui/client` source: `runAgent`
calls `this.run()` which is what `PersistingAgent` overrides). Choosing
`PersistingAgent` preserves the proven coalescing logic and keeps the runner
focused on routing concerns.

### 6.2 Synthesis content strategy

Generic `{ ok: true }` is enough for the LLM in 90% of cases — it only needs
"the tool ran" to continue. The exception is when the tool result carries an
identifier the LLM references in subsequent turns (e.g.
`render_chart.chartId` → "update the sales-pie chart"). Add a per-tool case
in `synthesizeToolCallResult` only when that criterion applies. Document the
criterion at the function header so future maintainers know when a new
per-tool case is needed.

### 6.3 RUN_STARTED.input omission is intentional and safe

`reconstructFromDb` emits `RUN_STARTED` events without an `input` payload.
`@ag-ui/core` schema makes `input` optional, so this is type-valid. The
practical effect: CopilotKit's internal deduplication (which uses
`RUN_STARTED.input.messages` to suppress duplicate message events on replay)
becomes a no-op. **This is what we want** — our DB rows are the canonical
timeline, we do not want CopilotKit second-guessing them. Further,
`PersistedAgentRunner.connect()` never calls `InMemoryAgentRunner.connect()`
unless an active run exists in-process, so the dedup code path is rarely
reached anyway.

### 6.4 Live run + history page-refresh race

Reviewer A flagged: if a user refreshes mid-run and `isRunning` returns
`false` between event arrival and DB commit (because `PersistingAgent`'s
`recordEvent` is fire-and-forget), the reconstructor sees a run that has not
yet been marked `succeeded`. The synthesis branch fires with
`runStatus !== "succeeded"` and emits a `synthetic_run_aborted` failure
envelope.

This is acceptable behaviour:

- The user sees the last unpersisted seconds of activity as "cancelled" in
  history; the chart itself still renders correctly because it was added to
  `outcomeStore` client-side at handler time
- No crash, no token waste
- Resolves automatically on next page load (events are flushed by then)

No DB lock is added — the failure-envelope fallback is sufficient.

### 6.5 Backend path runId threading

Reviewer B recommended threading `runId` via `ChatContext.runner` instead of
modifying `runWithAgents`'s function signature. Adopted — see §4.2. Change is
localized to two files and one type definition.

### 6.6 Bookkeeping path stays unchanged

`runner.ts`'s bookkeeping fast path (`/info`, `/threads/*`) constructs a stub
runtime without creating an `entity_run`. No `runId` is available, so no
`PersistedAgentRunner` is constructed. The default `InMemoryAgentRunner` is
used. This is correct — bookkeeping doesn't emit persistable events.

## 7. Implementation steps

```
Step 1: Re-exports + tests
   1.1  Add AgentRunner / InMemoryAgentRunner + request types to index.server.ts
   1.2  Verify imports work from src/lib/copilot/

Step 2: Implement event-reconstruction.ts + unit tests
   2.1  Async generator + from()
   2.2  Per-event-type emitters
   2.3  Synthesis for missing TOOL_CALL_RESULT
   2.4  Cancelled/failed run handling
   2.5  Unit tests covering §10 cases
   2.6  MessageSchema.parse + compactEvents validity check in tests

Step 3: Implement persisted-agent-runner.ts + unit tests
   3.1  run() wraps with PersistingAgent, delegates to inner
   3.2  connect() uses switchMap (per reviewer A) — not defer/mergeAll
   3.3  isRunning / stop delegate
   3.4  Unit tests covering construction errors, delegation, branch coverage

Step 4: Wire up runner.ts + runtime.server.ts behind env flag
   4.1  Add NANGO_RUNNER_BACKEND env handling
   4.2  built-in run path: remove outer PersistingAgent wrap, construct runner
   4.3  backend run path: same + thread runner through ChatContext.runner
   4.4  Bookkeeping path: unchanged
   4.5  ChartPanel: keep useThreadHydration for now (rollback safety)

Step 5: Manual test in both modes
   5.1  NANGO_RUNNER_BACKEND=memory (default): all existing flows pass
   5.2  NANGO_RUNNER_BACKEND=db: full §11 checklist

Step 6: Switch default to "db"
   6.1  Code default flips
   6.2  Observe for one week

Step 7: Cleanup (after stability confirmed)
   7.1  Remove useThreadHydration import + call from ChatPanel.tsx
   7.2  Delete src/hooks/useThreadHydration.ts
   7.3  Revert ChartPreviewCard isCompletedReplay + SuccessCard
   7.4  Add admin-debug comment to /api/threads/[threadId]/messages route

Step 8 (optional): Remove env flag
   8.1  Drop NANGO_RUNNER_BACKEND, default permanently to db-backed runner
```

Each step is independently shippable and revertible.

## 8. Detailed `PersistedAgentRunner` implementation

```ts
// src/lib/copilot/persisted-agent-runner.ts
import "server-only";

import { from, type Observable } from "rxjs";
import { switchMap } from "rxjs/operators";

import {
  AgentRunner,
  InMemoryAgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type BaseEvent,
} from "@/lib/copilot/index.server";
import { PersistingAgent } from "@/lib/runner/persisting-agent";
import type { childLogger } from "@/lib/observability/logger";

import { reconstructFromDb } from "./event-reconstruction";

interface PersistedAgentRunnerConfig {
  /** Owner of all threads this runner accesses. Scopes DB queries. */
  ownerId: string;
  /** Required when this runner handles `run()`; absent when only `connect()`. */
  runId?: string;
  /** Seq offset for the first persisted event. Defaults to 0. */
  startSeq?: number;
  log: ReturnType<typeof childLogger>;
}

/**
 * AgentRunner implementation that backs CopilotKit's `/run` and `/connect`
 * endpoints with the project's `entity_run_event` table.
 *
 * Architecture: form C-1. The runner delegates `run()` to an internal
 * `InMemoryAgentRunner` after wrapping the inner agent with `PersistingAgent`
 * (which tees AG-UI events into the DB). `connect()` either delegates back to
 * the in-memory runner (when an active run exists in-process) or reconstructs
 * a synthetic AG-UI stream from `entity_run_event`.
 *
 * KNOWN LIMITATION: `InMemoryAgentRunner.GLOBAL_STORE.historicRuns` keeps
 * retaining events per thread for the process lifetime. After this migration
 * the data is no longer functionally consumed (connect goes to DB) but still
 * accumulates. See `docs/persisted-agent-runner-migration.md` §5 for sizing
 * and upgrade path.
 */
export class PersistedAgentRunner extends AgentRunner {
  private readonly inner = new InMemoryAgentRunner();

  constructor(private readonly cfg: PersistedAgentRunnerConfig) {
    super();
  }

  run(req: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (!this.cfg.runId) {
      throw new Error(
        "PersistedAgentRunner.run() requires `runId` in config — caller must " +
          "create an entity_run row before invoking run().",
      );
    }
    const wrapped = new PersistingAgent({
      inner: req.agent,
      runId: this.cfg.runId,
      startSeq: this.cfg.startSeq ?? 0,
    });
    return this.inner.run({ ...req, agent: wrapped });
  }

  connect(req: AgentRunnerConnectRequest): Observable<BaseEvent> {
    // Per reviewer A: switchMap is cleaner than defer + mergeAll for the
    // async branch decision.
    return from(this.inner.isRunning({ threadId: req.threadId })).pipe(
      switchMap((isRunning) => {
        if (isRunning) {
          // Active run in this process — delegate to in-memory runner for
          // live tailing (multi-subscriber pubsub + historic event replay).
          return this.inner.connect(req);
        }
        // No active run — reconstruct from DB. Covers post-restart history
        // browsing and idle-thread reopens alike.
        return reconstructFromDb({
          threadId: req.threadId,
          ownerId: this.cfg.ownerId,
          log: this.cfg.log,
        });
      }),
    );
  }

  isRunning(req: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.inner.isRunning(req);
  }

  stop(req: AgentRunnerStopRequest): Promise<boolean | undefined> {
    return this.inner.stop(req);
  }
}
```

## 9. Detailed `reconstructFromDb` implementation

```ts
// src/lib/copilot/event-reconstruction.ts
import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { from, type Observable } from "rxjs";

import {
  EventType,
  type BaseEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ReasoningStartEvent,
  type ReasoningEndEvent,
  type ReasoningMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type RunErrorEvent,
} from "@/lib/copilot/index.server";
import { db } from "@/lib/db";
import {
  EntityRunEventTable,
  EntityRunTable,
  type EntityRunEventEntity,
  type EntityRunEntity,
} from "@/lib/db/schema";
import type { childLogger } from "@/lib/observability/logger";

interface ReconstructArgs {
  threadId: string;
  ownerId: string;
  log: ReturnType<typeof childLogger>;
}

export function reconstructFromDb(args: ReconstructArgs): Observable<BaseEvent> {
  return from(generateEvents(args));
}

async function* generateEvents(args: ReconstructArgs): AsyncIterable<BaseEvent> {
  const runs = await fetchRuns(args);
  if (runs.length === 0) return;

  const eventsByRun = await fetchEventsByRun(runs.map((r) => r.id));

  for (const run of runs) {
    yield runStartedEvent(args.threadId, run.id);

    const events = eventsByRun.get(run.id) ?? [];
    const resolvedToolCallIds = collectResolvedToolCalls(events);

    for (const ev of events) {
      yield* eventRowToAgUi(ev, args.threadId, run.id);
      if (ev.type === "tool_call_chunk") {
        const payload = ev.payload as { toolCallId: string; toolName: string; args: string };
        if (!resolvedToolCallIds.has(payload.toolCallId)) {
          yield synthesizeToolCallResult(payload, run.status);
        }
      }
    }

    yield runFinishedEvent(args.threadId, run.id);
  }
}

async function fetchRuns(args: ReconstructArgs): Promise<EntityRunEntity[]> {
  return db
    .select()
    .from(EntityRunTable)
    .where(
      and(
        eq(EntityRunTable.threadId, args.threadId),
        eq(EntityRunTable.ownerId, args.ownerId),
        isNull(EntityRunTable.parentRunId),
      ),
    )
    .orderBy(asc(EntityRunTable.startedAt), asc(EntityRunTable.createdAt));
}

async function fetchEventsByRun(
  runIds: string[],
): Promise<Map<string, EntityRunEventEntity[]>> {
  if (runIds.length === 0) return new Map();
  const events = await db
    .select()
    .from(EntityRunEventTable)
    .where(inArray(EntityRunEventTable.runId, runIds))
    .orderBy(asc(EntityRunEventTable.runId), asc(EntityRunEventTable.seq));

  const map = new Map<string, EntityRunEventEntity[]>();
  for (const ev of events) {
    const list = map.get(ev.runId);
    if (list) list.push(ev);
    else map.set(ev.runId, [ev]);
  }
  return map;
}

function collectResolvedToolCalls(events: EntityRunEventEntity[]): Set<string> {
  const resolved = new Set<string>();
  for (const ev of events) {
    if (ev.type === "tool_call_result") {
      const tcid = (ev.payload as { toolCallId?: string })?.toolCallId;
      if (tcid) resolved.add(tcid);
    }
  }
  return resolved;
}

function* eventRowToAgUi(
  ev: EntityRunEventEntity,
  threadId: string,
  runId: string,
): Iterable<BaseEvent> {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "message": {
      const messageId = (p.messageId as string | undefined) ?? `${runId}.msg.${ev.seq}`;
      const role = (p.role as string | undefined) ?? "assistant";
      const text = (p.text as string | undefined) ?? "";
      yield textStart(messageId, role);
      if (text.length > 0) yield textContent(messageId, text);
      yield textEnd(messageId);
      break;
    }
    case "tool_call_chunk": {
      const toolCallId = (p.toolCallId as string | undefined) ?? "";
      if (!toolCallId) break;
      const toolCallName = (p.toolName as string | undefined) ?? "unknown";
      const args = (p.args as string | undefined) ?? "";
      yield toolStart(toolCallId, toolCallName);
      if (args.length > 0) yield toolArgs(toolCallId, args);
      yield toolEnd(toolCallId);
      break;
    }
    case "tool_call_result": {
      const toolCallId = (p.toolCallId as string | undefined) ?? "";
      if (!toolCallId) break;
      const content = (p.content as string | undefined) ?? JSON.stringify(null);
      yield toolResult(toolCallId, content, `${runId}.tool.${ev.seq}`);
      break;
    }
    case "reasoning": {
      const messageId = (p.messageId as string | undefined) ?? `${runId}.reasoning.${ev.seq}`;
      const text = ((p.text as string | undefined) ?? "").trim();
      if (text.length === 0) break;
      yield reasoningStart(messageId);
      yield reasoningMsgStart(messageId);
      yield reasoningMsgContent(messageId, text);
      yield reasoningMsgEnd(messageId);
      yield reasoningEnd(messageId);
      break;
    }
    case "error": {
      yield runError((p.message as string | undefined) ?? "Run errored");
      break;
    }
    // started / finished / degraded / workflow_node_*: we wrap each
    // run with our own RUN_STARTED / RUN_FINISHED, so suppress these
    // DB rows. (Doc-only rename — see §3.3 footnote.)
    default:
      break;
  }
}

/**
 * Build a synthetic TOOL_CALL_RESULT for a tool_call_chunk that has no
 * matching tool_call_result row in DB.
 *
 * Add a per-tool case here only when:
 *   - The tool is a frontend tool (no `execute()`), AND
 *   - The tool's result content carries an identifier the LLM references
 *     in subsequent turns (e.g. render_chart's chartId — "update the
 *     sales-pie chart").
 *
 * For most tools the generic `{ ok: true }` envelope is sufficient — the
 * LLM only needs "the tool ran" to continue.
 */
function synthesizeToolCallResult(
  payload: { toolCallId: string; toolName: string; args: string },
  runStatus: string,
): ToolCallResultEvent {
  if (runStatus !== "succeeded") {
    return buildResult(
      payload.toolCallId,
      JSON.stringify({ ok: false, error: "synthetic_run_aborted" }),
    );
  }
  if (payload.toolName === "render_chart") {
    try {
      const args = JSON.parse(payload.args) as { chartId?: unknown };
      if (typeof args.chartId === "string" && args.chartId.length > 0) {
        return buildResult(
          payload.toolCallId,
          JSON.stringify({ ok: true, chartId: args.chartId }),
        );
      }
    } catch {
      /* fall through to generic envelope */
    }
  }
  return buildResult(payload.toolCallId, JSON.stringify({ ok: true }));
}

// Typed event constructors — avoid `as BaseEvent` casts per reviewer B.

function runStartedEvent(threadId: string, runId: string): RunStartedEvent {
  return { type: EventType.RUN_STARTED, threadId, runId };
}
function runFinishedEvent(threadId: string, runId: string): RunFinishedEvent {
  return { type: EventType.RUN_FINISHED, threadId, runId };
}
function textStart(messageId: string, role: string): TextMessageStartEvent {
  return { type: EventType.TEXT_MESSAGE_START, messageId, role };
}
function textContent(messageId: string, delta: string): TextMessageContentEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta };
}
function textEnd(messageId: string): TextMessageEndEvent {
  return { type: EventType.TEXT_MESSAGE_END, messageId };
}
function toolStart(toolCallId: string, toolCallName: string): ToolCallStartEvent {
  return { type: EventType.TOOL_CALL_START, toolCallId, toolCallName };
}
function toolArgs(toolCallId: string, delta: string): ToolCallArgsEvent {
  return { type: EventType.TOOL_CALL_ARGS, toolCallId, delta };
}
function toolEnd(toolCallId: string): ToolCallEndEvent {
  return { type: EventType.TOOL_CALL_END, toolCallId };
}
function toolResult(toolCallId: string, content: string, messageId: string): ToolCallResultEvent {
  return { type: EventType.TOOL_CALL_RESULT, toolCallId, content, role: "tool", messageId };
}
function buildResult(toolCallId: string, content: string): ToolCallResultEvent {
  return toolResult(toolCallId, content, `synth.${toolCallId}`);
}
function reasoningStart(messageId: string): ReasoningStartEvent {
  return { type: EventType.REASONING_START, messageId };
}
function reasoningEnd(messageId: string): ReasoningEndEvent {
  return { type: EventType.REASONING_END, messageId };
}
function reasoningMsgStart(messageId: string): ReasoningMessageStartEvent {
  return { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" };
}
function reasoningMsgContent(messageId: string, delta: string): ReasoningMessageContentEvent {
  return { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta };
}
function reasoningMsgEnd(messageId: string): ReasoningMessageEndEvent {
  return { type: EventType.REASONING_MESSAGE_END, messageId };
}
function runError(message: string): RunErrorEvent {
  return { type: EventType.RUN_ERROR, message, code: "DB_REPLAY" };
}
```

## 10. Test plan

### 10.1 `event-reconstruction.test.ts`

- [ ] Empty thread (no runs) → empty Observable (completes immediately)
- [ ] Single run, text-only → `RUN_STARTED` + `TEXT_MESSAGE_*` triplet + `RUN_FINISHED`
- [ ] Single run with real `tool_call_result` (backend bridge) → emitted as-is, no synthesis
- [ ] Single run with `tool_call_chunk` and no result, run succeeded → synthesized `{ ok: true }` (or `{ ok: true, chartId }` if render_chart)
- [ ] Single run with chunk + no result + failed run status → `{ ok: false, error: "synthetic_run_aborted" }`
- [ ] Multi-run thread → multiple `RUN_STARTED` / `RUN_FINISHED` pairs in chronological order
- [ ] Run with reasoning event → full `REASONING_*` quintuplet
- [ ] Run with `degraded` row → suppressed (admin-only)
- [ ] Run with `workflow_node_*` row → suppressed (workflow forensics)
- [ ] Run with `error` row → emits `RUN_ERROR`
- [ ] Cross-owner query (wrong `ownerId`) → empty stream (security boundary)
- [ ] Emitted events all pass `MessageSchema.parse` + `compactEvents` consumption

### 10.2 `persisted-agent-runner.test.ts`

- [ ] `run()` without `runId` in config → throws
- [ ] `run()` wraps agent with `PersistingAgent` before delegating to inner
- [ ] `connect()` when `isRunning=true` → events come from inner (real-time)
- [ ] `connect()` when `isRunning=false` → events come from `reconstructFromDb`
- [ ] `isRunning()` / `stop()` → delegate to inner

### 10.3 Manual E2E (after Step 5 flag flip)

- [ ] Restart server. Click on a thread with historical charts.
      Expected: messages display correctly, "View in Outcomes" link present,
      **no new agent run triggered** (no new entity_run rows).
- [ ] Restart server. Click on a text-only historical thread.
      Expected: messages display correctly, no flash-and-disappear.
- [ ] Switch from thread A to thread B and back, no restart.
      Expected: each thread shows its own messages cleanly; no residue.
- [ ] Generate a new chart in a fresh thread; main panel updates correctly.
- [ ] Continue an existing thread (live, no restart). Frontend tool card
      transitions inProgress → executing → complete normally.
- [ ] Backend agent (mastra or dify) historical thread navigation works.
- [ ] Multiple browser tabs on the same thread during an active run all
      receive live events.
- [ ] Long thread (>50 runs) replay performance acceptable (<2s for replay).

## 11. Rollback strategy

Each step is independently revertible:

- **Before Step 7 cleanup**: `NANGO_RUNNER_BACKEND=memory` returns to the
  previous behaviour. `useThreadHydration` is still present and functional.
- **After Step 7 cleanup, before flag removal**: `NANGO_RUNNER_BACKEND=memory`
  still works as a fallback, but the chat history UI is degraded (frontend-tool
  cards show `inProgress`). Revert the ChartPanel + ChartPreviewCard cleanup
  commits if needed.
- **After Step 8 flag removal**: full revert requires restoring `PersistedAgentRunner`
  → `InMemoryAgentRunner` change. Single-file revert in `runner.ts` +
  `runtime.server.ts`.

The env flag default flip in Step 6 is the gating decision — observe for one
week before proceeding to Step 7.

## 12. Open items reviewers can re-check

- Sizing assumption in §5 (75 MB / 10 users / 30 days) — validate against
  production memory monitoring if available.
- Confirm `RunStartedEvent` / `RunFinishedEvent` typed constructors match the
  exact schema from `@ag-ui/core` (no unexpected required fields beyond
  `type` + `threadId` + `runId`).
- Confirm `EntityRunEventTable.payload` JSONB queries used by
  `reconstructFromDb` have acceptable performance on the largest thread in
  the dataset. Add a GIN index on `(payload->>'toolName')` if synthesis path
  performance regresses.

## 13. Final state (post-implementation)

Migration completed. All 15 steps shipped, plus four fixes uncovered during
manual E2E that the original design did not anticipate. The DB-backed
`AgentRunner` is now the unconditional code path; the legacy
`PersistingAgent` outer-wrap and the `NANGO_RUNNER_BACKEND` env flag are
both gone.

### Commit ledger

| Commit    | Step / fix                                                                         |
|-----------|------------------------------------------------------------------------------------|
| `b6c35dc` | Steps 1–5 — infra: vendor barrel, `event-reconstruction.ts`, `PersistedAgentRunner`, 25 unit tests |
| `9a5b9ed` | Steps 6–9 — wiring: `ChatContext.runner`, `runtime.server.ts` passthrough, `runner.ts` four branches |
| `af4a869` | Step 13 — client cleanup: delete `useThreadHydration`, drop `ChartPreviewCard.isCompletedReplay` |
| `ca9f739` | Step 12 — flip default to db                                                       |
| `3e56173` | Step 15 — remove env flag, db is permanent                                         |
| `05f7792` | Fix: copy inner agent state (messages / state / threadId) to PersistingAgent wrap so `prepareRunAgentInput` sees the conversation |
| `fc9b9d8` | Fix: persist user prompt as `message` event row at seq 0 with the client's original message id, so post-finalize `/connect` dedupes on the client |
| `4b5ea46` | Cleanup: drop the `inputTask` synthesis fallback in `reconstructFromDb` — no pre-launch data to migrate |
| (current) | Cleanup: `/api/threads/[threadId]/messages` admin endpoint now reads the user-message event row directly (no synthesis, no role mislabel) |

### Final code shape

- **`src/lib/copilot/event-reconstruction.ts`** — single path: query
  `entity_run` + `entity_run_event` for the `(threadId, ownerId)` tuple, yield
  one wrapper `RUN_STARTED` (no `input`) → per-row events from
  `eventRowToAgUi` → synthetic `TOOL_CALL_RESULT` for frontend-tool chunks
  without a real result → wrapper `RUN_FINISHED`. No user-message synthesis.

- **`src/lib/copilot/persisted-agent-runner.ts`** — Form C-1 unchanged.
  `run()` wraps `req.agent` with `PersistingAgent`, copies
  `messages / state / threadId` across the wrap (fix `05f7792`), delegates to
  `InMemoryAgentRunner`. `connect()` switchMaps on `inner.isRunning`:
  live-tail vs `reconstructFromDb`.

- **`src/lib/runner/runner.ts`** — `extractRunInput` extracts
  `userMessageId` alongside `task`. `recordUserMessage` writes the prompt
  as a `message` row at seq 0 with that id. Both HTTP /run paths
  (`runChatRequest`, `runBuiltinChatRequest`) call it after `recordRunStart` and
  after `recordCapabilityDegradations`, then construct `PersistedAgentRunner`
  with `startSeq` past the persisted rows.

- **`src/lib/runner/persisting-agent.ts`** — unchanged from before the
  migration; consumed only by `PersistedAgentRunner` and by the programmatic
  `startSync` / `startAsync` paths.

- **`src/lib/backends/types.ts`** — `ChatContext.runner?:` and
  `IBackendChatHandler` docstrings reflect the always-on shape.

- **`src/lib/backends/runtime.server.ts`** — spreads `ctx.runner` into
  `new CopilotRuntime(...)`.

- **`/api/threads/[threadId]/messages`** — admin debug only. Reads the
  user-message event row directly; no `inputTask` synthesis, no role
  mislabel.

### Architectural invariants the implementation preserves

1. `/connect` is the canonical history-replay path. Client-side hydration via
   REST is gone — `useThreadHydration` was deleted in Step 13.

2. The user prompt is durable: it lives as a `message` event row with the
   client's original UUID, so live state and replayed state share the same id
   and CopilotKit's apply pipeline dedupes correctly.

3. CopilotKit's frontend-tool continuation pattern (one user turn ⇒ two
   `entity_run` rows) is opaque to replay: both rows persist the same user
   message id, the second one's TEXT_MESSAGE_* is dropped client-side by the
   id check in `apply.default.ts`.

4. `PersistedAgentRunner` is **per-request** — never share across owners.
   `ownerId` scopes the DB query in `reconstructFromDb`.

### Deliberate trade-offs left in place

- Programmatic dispatches (`runner.start({mode}})` → `startSync` /
  `startAsync`) do NOT call `recordUserMessage`. Their prompts have no
  client-generated id and their chat-style replay is admin-only; the run
  forensics admin UI is the proper surface for those.

- `GLOBAL_STORE.historicRuns` in CopilotKit's `InMemoryAgentRunner` still
  accumulates events per run for the process lifetime (C-1 trade-off, §5).
  Acceptable up to ~100 concurrent users on Nango's single-node deployment.

- Pre-fix DB rows (any that don't have a user-message event row) lose the
  user side of the chat on replay. Project hasn't launched — no real data,
  no backward-compat fallback in code.

### Open items still relevant

§12 still applies. The sizing assumption is unvalidated until production
metrics arrive; the GIN index on `payload->>'toolName'` remains optional
until replay performance regresses.
