# Runner — Event Pipeline

> Status: v1
> Audience: backend / frontend engineers working on the runner,
> chat history reconstruction, or admin forensics.
> See also: `docs/orchestrator.md` (the surrounding `entity_run`
> kernel), `docs/architecture.md` §runtime, `docs/threadid-lifecycle.md`.

This document is the single source of truth for **how AG-UI events
flow from the wire into Nango's `entity_run_event` table and back
out into the chat / admin UIs**. Every other document references
the schema sketch in `docs/orchestrator.md` §2 — this one explains
the pipeline.

---

## 1. Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                        AG-UI BaseEvent stream                      │
│            (from bridge, BuiltInAgent, or sub-run)                 │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
                               ▼
                ┌────────────────────────────┐
                │  PersistingAgent (decorator)│
                │   — coalesces deltas        │
                │   — tees to entity_run_event│
                │   — passes BaseEvent thru   │
                └──────┬──────────────────┬───┘
                       │                  │
        (DB write,     │                  │  (live SSE to browser
         fire-and-forget)                 │   — unchanged shape)
                       ▼                  ▼
        ┌─────────────────────┐    ┌──────────────────────┐
        │ entity_run_event    │    │ CopilotKit /         │
        │ — append-only,      │    │ chat client          │
        │ — coalesced rows,   │    │ — token-level deltas │
        │ — runId+seq PK      │    │   for UX             │
        └────────┬────────────┘    └──────────────────────┘
                 │
        ┌────────┴───────────────────────┐
        ▼                                ▼
┌─────────────────────────┐     ┌──────────────────────────┐
│ /api/threads/[tid]/     │     │ /admin/thread/[id]       │
│ messages                │     │ (ThreadDetailView)       │
│ — replay as AG-UI       │     │ — forensic timeline,     │
│   Message[]             │     │   tone-coded badges      │
└─────────────────────────┘     └──────────────────────────┘
```

The pipeline has **six stages**: reception, coalescing, persistence,
conversation linkage, replay, and admin display. Each is described
once below and never duplicated elsewhere.

---

## 2. Stage 1 — Reception

AG-UI events enter Nango from three sources, all reaching the same
`PersistingAgent` decorator:

| Source | Producer | Notes |
|---|---|---|
| Backend chat | `BridgeAgent` from `bridge-runtime-kit.server.ts` (agno, Mastra, Dify) | The bridge translates upstream REST/SSE into AG-UI events on the fly. See `docs/backend-integration.md`. |
| Built-in chat | `BuiltInAgent` from `@copilotkit/runtime/v2` | Native AG-UI emitter. |
| Programmatic sub-run | Same as above, dispatched via `runner.start({ mode: "sync" })` | E.g. `delegate_to_agent` calls into a child run. |

The wrapper:

```ts
new PersistingAgent({
  inner: agent,            // agent that emits BaseEvent stream
  runId: createdRun.id,    // the entity_run row this stream binds to
})
```

Persistence is **fire-and-forget**: a DB write error is logged but
never blocks the chat stream. Forensics is observability — it must
not stutter the user-facing UX.

---

## 3. Stage 2 — Coalescing

The wire delivers AG-UI events at **token granularity**:
`TEXT_MESSAGE_CONTENT` arrives once per token, `REASONING_MESSAGE_CONTENT`
once per reasoning chunk, `TOOL_CALL_ARGS` once per JSON delta. A
500-token reply on the wire is 500+ events. Persisting one row per
event would explode `entity_run_event` for negligible value (the user
already sees real-time deltas through the unmodified pass-through
arm).

### 3.1 In-memory accumulators
PersistingAgent buffers tokens for `message`, `reasoning`, and `tool_call_args` and flushes them to the DB on segment boundaries (`_END` markers, ID changes, or `RUN_FINISHED`/`RUN_ERROR`).

## 4. Stage 3 — Persistence

Drained buffers are written to `entity_run_event` as a single row
each, identified by `(runId, seq)` where `seq` increases monotonically
from 0 within a run.

### 4.1 Schema

```
entity_run_event
├── runId   uuid     references entity_run.id  ON DELETE CASCADE
├── seq     int      monotonic per run
├── type    text     EntityRunEventType (see §8)
├── payload jsonb    shape varies by type (see §9)
└── ts      timestamp
PRIMARY KEY (runId, seq)
```

`type` is plain text because it's a closed union policed at the
TypeScript layer (`EntityRunEventType` in `lib/db/schema.ts`); we
don't pay for a Postgres CHECK constraint when the writer is
single-source.

### 4.2 Coalesced events emit one row

| `EntityRunEventType` | Wire source | One row per |
|---|---|---|
| `started` | `RUN_STARTED` | run start |
| `message` | `TEXT_MESSAGE_*` (coalesced) | continuous assistant text segment |
| `reasoning` | `REASONING_MESSAGE_*` (coalesced) | continuous reasoning segment |
| `tool_call_chunk` | `TOOL_CALL_START + ARGS + END` (coalesced) | one tool call's *decision* (name + full args) |
| `tool_call_result` | `TOOL_CALL_RESULT` | one tool call's *execution* (content) |
| `finished` | `RUN_FINISHED` | run finalised successfully |
| `error` | `RUN_ERROR` | run errored |
| `degraded` | NOT from AG-UI (build-time, written by `dispatch/builtin.ts::recordDegradation` BEFORE the agent stream starts) | one MCP / model / spec capability the runtime silently dropped at agent build. Payload `{ref, refName, reason, message}` — the `reason` prefix encodes the capability axis (`mcp_*` / `spec_*` / `model_*` / `supervisor_*`), so there is no separate `capability` field. Surfaces in admin run forensics with an amber accent so operators can attribute "missing tool" symptoms to a precise build-time cause without grepping process logs. |
| `workflow_node_attempt_started` | NOT from AG-UI (workflow engine `emitEvent` → `workflow-run-recorder.ts`, D4a) | one node attempt begins, on `forceFresh: true` paths only |
| `workflow_node_attempt_failed`  | same | one node attempt threw before retry exhausted |
| `workflow_node_completed`       | same | one node finished (success or cache hit), payload carries `{nodeId, attempt, durationMs, cached?, outputs}` |

A 500-token reply → 1 `message` row. A tool call (start + N args +
end + result) → 2 rows: one `tool_call_chunk`, one `tool_call_result`.

### 4.3 TTFT and timestamps
- **Event timestamps**: Coalesced rows (`message`, `reasoning`, `tool_call_chunk`) use the START time of the segment, not the flush time, to ensure accurate TTFT.
- **Run timestamps**: `entity_run.started_at` is stamped when the HTTP request is received, before agent build/MCP discovery, capturing the true user wait time.

### 4.4 Tool calls
- **chunk**: LLM decision (START+ARGS+END).
- **result**: Execution result. 
A chunk without a result indicates a dangling/failed tool call.

### 4.5 Continuation runs
When the LLM pauses on a frontend HITL tool and the user provides input, CopilotKit resumes. `extractRunInput` detects this and starts a new run where `input_task` is the tool result, avoiding duplicate user messages.

### 4.6 Cross-run tool-call resolution
Admin APIs pair `tool_call_chunk` from the original run with `tool_call_result` from the continuation run to calculate true duration, including user think time.

## 5. Stage 4 — Conversation Linkage

Three columns on `entity_run` link events back into a conversation:

```
entity_run
├── id            uuid             — this run
├── parent_run_id uuid (nullable)  — points to the spawning run
├── thread_id     text (nullable)  — CopilotKit thread (chat surface)
├── owner_id      uuid             — visibility scope
├── ...
```

### 5.1 `thread_id`

Set by `runner.runChatRequest` / `runner.runBuiltinChatRequest` from
the CopilotKit thread cookie. One thread accumulates many runs (one
per user turn). Sub-runs (supervisor delegation, async, scheduled)
**inherit** the thread id only when they belong to the user-visible
conversation — supervisor sub-runs do not (they live in admin
forensics only).

For the lazy two-phase capture (anonymous turn-1 → durable thread
after the assistant replies), see `docs/threadid-lifecycle.md`.

### 5.2 `parent_run_id`

Tree linkage. Depth-limited to 3 by `recursionDepth()` in
`event-store.ts`. The tree shape is what `/admin/thread/[id]` uses
to render sub-runs nested under their parent in the run timeline.

### 5.3 Owner scope

Every read filters by both `thread_id` and `owner_id =
session.user.id`. A user that guesses another user's threadId gets
an empty array — there is no shared-thread surface today.

---

## 6. Stage 5 — Replay

`GET /api/threads/[threadId]/messages` reconstructs an AG-UI
`Message[]` from `entity_run_event`. The route is the **single
source of truth** for chat history; per-provider Sessions APIs were
deleted as part of the unification work.

### 6.1 Run selection

```sql
SELECT id, input_task, started_at, created_at
FROM entity_run
WHERE thread_id = :tid
  AND owner_id  = :user
  AND parent_run_id IS NULL    -- exclude supervisor sub-runs
ORDER BY started_at, created_at;
```

`parent_run_id IS NULL` is the *strategy A (collapsed)* delegation
rendering: users see the supervisor's tool call as a single
invocation, not the expanded sub-run forest. Admins still get the
full tree via `/admin/thread/[id]`.

### 6.2 Event-to-Message projection

For each run, all events ordered by `seq`, dispatched through
`transformRunEvents()`:

| Event | Effect on message stream |
|---|---|
| `entity_run.input_task` | One `role: "user"` message at the top of the run. |
| `message` (assistant) | Open / replace the carrier assistant; flush previous one first. |
| `reasoning` | Flush carrier, emit `role: "reasoning"` (CopilotKit renders this natively as a thinking card). Empty reasoning rows are skipped. |
| `tool_call_chunk` | Append a fully-formed tool call to carrier's `toolCalls[]`. No buffering — the storage layer already coalesced. |
| `tool_call_result` | Flush carrier, emit `role: "tool"` with `toolCallId` + `content`. |
| `started` / `finished` / `error` / `degraded` | Lifecycle / capability events — not surfaced as a chat message. |
| `workflow_node_*` | Workflow forensics only — not surfaced as a chat message. |

The carrier assistant is created lazily on first tool call so that
"tool call without preceding text" turns produce an empty assistant
holding the call array (matches the OpenAI tool-message convention).

### 6.3 What replay deliberately drops

- Reasoning that is empty after trim (transport framing without
  delta content).
- All lifecycle / capability / workflow-node events (`started` /
  `finished` / `error` / `degraded` / `workflow_node_*`) — they live
  in admin run forensics only.
- Half-built tool calls. If a `tool_call_chunk` is missing
  (run died before the trio completed), nothing is emitted to chat —
  but the run itself is in `failed` / `cancelled` status, so the
  user already sees the outcome via the task card.

---

## 7. Stage 6 — Admin Display

`/admin/thread/[id]` (`src/components/admin/ThreadDetailView.tsx`)
renders the per-thread run timeline. Each run card on the left
column inlines TTFT / tool counts / sub-run counts; selecting a
card mounts `EventTimeline` on the right with the forensic event
log. Cap on the API side at 1000 events per run
keeps the wire payload bounded for chatty agno tool chains; "events
truncated" is surfaced when the cap fires.

### 7.1 Layout

Left column (40%): run identity, owner, status, input, parent
breadcrumb, immediate children. Right column (60%): event timeline.
Both scroll independently. `min-w-0` is set on each grid child or a
long entity id / unbreakable URL would override the `[2fr_3fr]`
track ratio.

### 7.2 Per-row rendering

Each row shows: `▸ #seq  HH:MM:SS [type-badge] one-line summary`.

- **Heavy** rows (`message`, `reasoning`, `tool_call_chunk`,
  `tool_call_result`, `finished`, `error`, `degraded`, and the
  three `workflow_node_*`) are clickable and expand to a JSON
  pretty-print of the full payload.
- **Light** rows (`started`) collapse to a one-liner.
- The summary captures the most identifying field per type
  (toolName + args for `tool_call_chunk`, content for
  `tool_call_result`, summary for `finished`, message for `error`,
  `reason: refName` for `degraded`, `nodeId @ attempt` for
  `workflow_node_*`).

### 7.3 Forensic tone

A second colour overlay surfaces protocol-level success / failure
without keyword-sniffing free-form output:

| Tone | Trigger | Source field |
|---|---|---|
| 🟢 success | `tool_call_result.content` parses to JSON with `isError === false` (MCP) or `ok === true` (supervisor internal tools) | embedded in payload |
| 🔴 failure | same, but `isError === true` / `ok === false` | embedded in payload |
| 🟡 warning | `tool_call_chunk` whose `toolCallId` never produced a matching `tool_call_result` | structural — orphan detection |
| (none) | raw string content / plain JSON without flag | — |

Computed once per render in `computeEventTones()`. We deliberately
do **not** sniff "error" / "exception" out of free-form content —
that's a misreport waiting to happen (a tool literally named
`parse_error_log` would always look failed).

---

## 8. Reference — AG-UI EventType ↔ EntityRunEventType

AG-UI 0.0.52 ships ~30 event types. Nango persists 11
(`EntityRunEventType` union, post-coalesce); the rest are either
folded into those 11 or dropped as transport-only framing.

### 8.1 Persisted (11 types)

Seven are AG-UI-sourced; four (`degraded`, plus the three
`workflow_node_*`) are written directly by Nango code outside the
AG-UI tee.

| `EntityRunEventType` | AG-UI source | Strategy |
|---|---|---|
| `started` | `RUN_STARTED` | Direct write |
| `message` | `TEXT_MESSAGE_START` + `_CONTENT` + `_CHUNK` + `_END` | Coalesce; one row per segment |
| `reasoning` | `REASONING_MESSAGE_START` + `_CONTENT` + `_END` | Coalesce; one row per segment |
| `tool_call_chunk` | `TOOL_CALL_START` + N×`_ARGS` + `_END` | Coalesce; one row per call decision |
| `tool_call_result` | `TOOL_CALL_RESULT` | Direct write |
| `finished` | `RUN_FINISHED` | Direct write |
| `error` | `RUN_ERROR` | Direct write |
| `degraded` | — (build-time, `dispatch/builtin.ts::recordDegradation`) | Direct write, BEFORE AG-UI stream starts |
| `workflow_node_attempt_started` | — (workflow engine `emitEvent`, D4a) | Direct write, refresh path only |
| `workflow_node_attempt_failed`  | — | Direct write, refresh path only |
| `workflow_node_completed`       | — | Direct write, refresh path only |

### 8.2 Dropped — but transparently passed to the browser

| AG-UI EventType | Reason for drop |
|---|---|
| `TOOL_CALL_CHUNK` | Currently no upstream provider emits the single-event variant. **Has a TODO in PersistingAgent** — when an upstream eventually emits it, feed into `pendingToolCalls` and flush at the next boundary. |
| `REASONING_MESSAGE_CHUNK` | Same as above: combined start/content/end variant. No current emitter. |
| `REASONING_START` / `REASONING_END` | Section-level frames around `_MESSAGE_*`; we only persist the message-level segments. |
| `REASONING_ENCRYPTED_VALUE` | OpenAI o1 encrypted reasoning ciphertext — opaque, can't be displayed. |
| `THINKING_START` / `_END` / `_TEXT_MESSAGE_*` | Deprecated alias for REASONING_*; also: no current emitter. |
| `STATE_SNAPSHOT` / `STATE_DELTA` | LangGraph-style state sync — needed by browser, no forensic value. |
| `MESSAGES_SNAPSHOT` | History snapshot — already in our `entity_run_event`, persisting would double-count. |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | Activity stream (rarely used). |
| `STEP_STARTED` / `STEP_FINISHED` | AG-UI step framing. Workflow forensics use dedicated `workflow_node_*` types written directly by the engine — no AG-UI tee, no streaming — so these frames carry no signal we need to persist. |
| `RAW` / `CUSTOM` | Free-form pass-through; no persistable schema. |

`PersistingAgent` is a **tee, not a filter** — every event is still
forwarded to CopilotRuntime so the browser receives the full stream.
Only persistence is selective.

---

## 9. Reference — Payload Shapes

Verbatim from `entity_run_event.payload` (jsonb). All fields are
present unless marked `(optional)`.

```ts
type Payloads = {
  started:           { ts: number };
  message:           { messageId: string; role: string; text: string };
  reasoning:         { messageId: string; text: string };
  tool_call_chunk:   { toolCallId: string; toolName: string; args: string };
  tool_call_result:  { toolCallId: string; content: string };
  finished:          { summary?: string; output?: unknown };
  error:             { message: string; errorType?: string };
  degraded:          { ref: string; refName: string | null; reason: string; message: string };
  workflow_node_attempt_started: { nodeId: number; attempt: number };
  workflow_node_attempt_failed:  { nodeId: number; attempt: number; errorCode: string; message: string };
  workflow_node_completed:       { nodeId: number; attempt: number; durationMs: number; cached?: boolean; outputs: Record<string, unknown> };
};
```

Notes:
- `args` is the raw coalesced JSON string emitted by the upstream
  LLM. It is not parsed at persist time — admin / replay code can
  `JSON.parse` defensively.
- `content` is similarly free-form. Tool-result tone detection in
  the admin UI tries to parse it but falls back to neutral when
  parsing fails or no flag field is present.
- `finished.output` is reserved for structured run output (e.g. a
  workflow's final state). Currently optional and rarely populated.
- `degraded.reason` prefix encodes the capability axis
  (`mcp_*` / `spec_*` / `model_*` / `supervisor_*`); there is no
  separate `capability` field.
- `workflow_node_*` carries the verbatim engine event payload
  (sans `runId`, which is already on the row). See
  `lib/workflows/engine/index.ts::WorkflowEngineEvent`.

---

## 10. Open Questions / Future Work
- Process `TOOL_CALL_CHUNK` single-event variant if upstreams adopt it.
- Decide mapping for `THINKING_*` vs `REASONING_*` when Anthropic is onboarded natively.
- Retention cleanup job (7-day horizon) needs implementation.
- Hot-path observability/aggregation for persistence failures.

## Pointers Into the Code

| Concern | File |
|---|---|
| AG-UI → row coalescing | `src/lib/runner/persisting-agent.ts` |
| `entity_run_event` write API | `src/lib/runner/event-store.ts` |
| `EntityRunEventType` union + payload doc | `src/lib/db/schema.ts` |
| Replay (`Message[]` reconstruction) | `src/app/api/threads/[threadId]/messages/route.ts` |
| Admin thread + run timeline + forensic tone | `src/components/admin/ThreadDetailView.tsx` + `src/components/admin/EventTimeline.tsx` |
| Run lifecycle / `entity_run` writes | `src/lib/runner/runner.ts` + `event-store.ts` |
| Boot-time stranded-run recovery | `src/lib/runner/recovery.ts` |
