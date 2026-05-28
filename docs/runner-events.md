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

PersistingAgent keeps three per-run buffers:

| Buffer | Filled by | Drained at |
|---|---|---|
| `pendingMessage: { messageId, role, text }` | `TEXT_MESSAGE_*` | next `TEXT_MESSAGE_END`, message-id change, tool boundary, or run-finalize |
| `pendingReasoning: { messageId, text }` | `REASONING_MESSAGE_*` | symmetrical to message |
| `pendingToolCalls: Map<toolCallId, { toolName, args }>` | `TOOL_CALL_START` + N×`TOOL_CALL_ARGS` | matching `TOOL_CALL_END` |

Tool-call buffer is keyed by `toolCallId` (not a single global slot)
because AG-UI permits multiple tool calls in flight concurrently —
deltas from different calls can interleave within one assistant turn.

### 3.2 Boundary semantics

A **boundary** is whatever closes a coalesced segment:
- the matching `_END` marker — the canonical case;
- the start of the next segment with a different `messageId` /
  `toolCallId` — defensive against bridges that forget `_END`;
- `RUN_FINISHED` / `RUN_ERROR` — the final flush.

`RUN_ERROR` and the rxjs `error` / `complete` arms also drain the
pending buffers before writing the terminal status. Partially-streamed
text from a cancelled run is preserved, not silently dropped.

### 3.3 Subscriber teardown

If the browser closes the tab:
1. CopilotRuntime tears the subscription down;
2. `bridge-runtime-kit`'s `AbortController` aborts the upstream fetch
   (LLM stops consuming tokens);
3. `finalize` flips the `entity_run` row from `running` to `cancelled`.

Without this path, rows used to sit in `running` for up to an hour
until the boot-recovery sweep flipped them.

---

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

### 4.3 TTFT and event timestamps

Two independent fixes keep TTFT (`MIN(event.ts) - entity_run.started_at`)
honest:

**(a) Coalesced rows anchor on segment START, not END.**
`entity_run_event.ts` for `message`, `reasoning`, `tool_call_chunk`
is captured at the moment the segment begins (TEXT_MESSAGE_START /
first CHUNK / REASONING_MESSAGE_START / TOOL_CALL_START), NOT at
the END / flush time when the row is actually written.
`PersistingAgent` records `startTs: new Date()` on the in-memory
accumulator and passes it through to
`recordEvent(runId, seq, type, payload, ts)`.

Why: a long assistant reply may stream for 10s. If `ts` reflected
END time, TTFT would include the entire streaming window.
Anchoring on START gives first-token time, the metric admins
actually want.

Single-point rows (`started`, `finished`, `error`, `degraded`,
`tool_call_result`, and the three `workflow_node_*` types) write
without a `ts` override, falling back to the DB column default
(`CURRENT_TIMESTAMP` at INSERT time).

**(b) `entity_run.started_at` anchors on HTTP-request-receipt, not
on agent-build-completion.**
Pre-this-change, the dispatch layer built the inner agent FIRST
(`buildBuiltinAgents` — MCP discovery, model resolution, supervisor
catalog composition) and only then called `recordRunStart`. A
single unreachable MCP server could add 10-30s of `fetch failed`
wait, but `started_at` was stamped AFTER that wait, so the timeline
showed `message` / `degraded` / `started` rows all bunched within
the same second — and TTFT looked artificially low while the user
had actually been staring at a blank screen the whole time.

Three dispatch paths (`runBuiltinChatRequest`, `startSync`,
`startAsync`) now record the run row + user-message row BEFORE the
build phase. The admin timeline now reads:

```
T0        message (user)     ← HTTP route received the prompt
                              │
                              │  ⏳ MCP discovery / model resolve
                              │     visible on the timeline as a gap
                              │
T0+Nsec   degraded            ← any build-time degradations
T0+Nsec   started             ← agent stream begins
T0+Nsec+δ message (assistant) ← first token, real TTFT
finished
```

A build-phase failure (specs all null, target missing, MCP build
threw) is now persisted as a `failed` entity_run row instead of
vanishing into the request log — admin can see it on `/admin/thread`.

Backend chat (agno / Mastra / Dify, via `runChatRequest`) was
already record-first because `handler.buildAgent` is a cheap
wrapper construction; it doesn't do MCP discovery.

**Clock domain.** `entity_run.started_at` / `finished_at` are
Node-side `new Date()`. Pre-this-change, `entity_run_event.ts` was
PG-side `CURRENT_TIMESTAMP` — a hidden clock mix that's negligible
on a single host but theoretically incorrect. Post-change,
coalesced rows use Node clock for consistency with the run row.

### 4.4 Why two rows per tool call

A tool call has two genuinely separate lifecycle stages:

| Stage | Driver | Duration | Persisted as |
|---|---|---|---|
| **Decision** | LLM emitting `TOOL_CALL_START + ARGS + END` | microseconds | `tool_call_chunk` |
| **Execution** | Tool actually runs and returns | seconds (or never) | `tool_call_result` |

A `tool_call_chunk` **without** a matching `tool_call_result` is the
durable signal of *"tool was invoked but produced no output"* — the
agent died, the tool timed out, or the backend deliberately skipped
the result emit (Agno does this on the assumption that CopilotKit
will emit RESULT itself). Admin run detail flags those rows in amber.

The `tool_call_chunk` naming aligns with AG-UI's `TOOL_CALL_CHUNK`
single-event variant — the OpenAI-streaming-style alternative to
the START/ARGS/END trio. None of agno / Mastra / Dify currently emit
the variant; when one does, persisting it slots straight into the
same row shape with no schema change. See §10.

### 4.5 Continuation runs

A **continuation run** is a fresh `entity_run` row produced when the
LLM was paused on a frontend / HITL tool call (`ask_user_choice`,
`ask_user_confirmation`, `ask_user_datetime`) and the user has just
supplied a result. CopilotKit re-posts the existing message history
with a new `role: "tool"` message appended — there is NO new user
message. The naive parse ("take the last user message as the
`entity_run.input_task`") would duplicate the prior turn's prompt,
producing two consecutive runs with identical `input_task` and no
visible signal of what triggered the second one.

`extractRunInput` detects this shape: when the tail of `messages`
is a contiguous block of `role: "tool"` entries, it returns them
as `triggeringToolResults` and the `task` field is set to the first
result's content (stringified, capped at 1000 chars). The chat
dispatch layer then takes one of two mutually-exclusive branches:

**(a) Normal chat turn** — `triggeringToolResults` empty:
```
entity_run.input_task = "<latest user message text>"
event seq 0: message  (role=user, text=<...>, messageId=<client id>)
event seq 1: degraded (build-time, optional)
event seq 2: started
...
```

**(b) Continuation turn** — `triggeringToolResults` non-empty:
```
entity_run.input_task = "<first tool result content>"
event seq 0..N-1: tool_call_result  (toolCallId=<from previous run>, content=<...>)
event seq N:     degraded (build-time, optional)
event seq N+1:   started
...
```

No `user_message` event is written in case (b). The pairing
`tool_call_chunk` lives on the PREVIOUS run (where the LLM emitted
it); admins follow the link by `toolCallId`. This keeps each run's
data flow aligned with its real trigger — chunk is the LLM's
output, result is the next run's input — and avoids the
duplicate-`message` visual noise the naive parse produced.

Backend chat (`runChatRequest`) applies the same branch for
symmetry; backend bridges (agno / Mastra / Dify) own their session
memory and rarely emit frontend tools, so case (b) is mostly a
built-in chat phenomenon.

Parsing rules live in `src/lib/runner/extract-run-input.ts` and are
unit-tested in `tests/unit/lib/runner/extract-run-input.test.ts`.

### 4.6 Cross-run tool-call resolution

`tool_call_chunk` and `tool_call_result` for the SAME `toolCallId`
can live in different `entity_run` rows whenever a continuation run
(§4.5) is involved. The admin thread API pairs them across the
whole thread before composing per-run metrics, so:

- A frontend / HITL tool that resolved one turn later renders as a
  single `success` row (blue Hammer) on the chunk-bearing run with
  a real `durationMs` that spans `chunk.ts → result.ts` (which for
  HITL **includes user think time** — the honest "how long did the
  LLM wait for this tool" answer).
- The continuation run's RunCard does NOT show a half-empty tool
  row — the result event is still on the timeline but is "consumed"
  by the chunk's aggregate up the thread.
- A truly dangling chunk (no result anywhere in the thread —
  the agent died, the bridge dropped the result, etc.) stays
  `pending` (amber) so it still flags operator attention. The
  amber signal is reserved for this real diagnostic case rather
  than fired on every HITL turn.

Aggregation is shaped so each `toolCallId` maps to **exactly one**
RunCard row, owned by `chunkRunId` if present (the run where the
LLM emitted the chunk — the "decision" stage), else falling back
to `resultRunId`. Ordering within a run is by `chunk.seq`. The
underlying helpers (`buildToolCallAggregates`,
`groupAggregatesByOwnerRun`, `aggregateToolCalls`) live in
`src/lib/runner/tool-call-aggregator.ts` and are unit-tested in
`tests/unit/lib/runner/tool-call-aggregator.test.ts`.

---

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

1. **`TOOL_CALL_CHUNK` accept path.** No provider currently emits
   it, so dropping is safe. When one does (likely when we ship a
   LangGraph-native bridge), accumulate into `pendingToolCalls` and
   flush at the next boundary (next non-chunk event with a different
   toolCallId / matching `TOOL_CALL_RESULT` / `RUN_FINISHED`). The
   row shape stays the same — only the case in PersistingAgent's
   switch needs filling. TODO is in place.
2. **Thinking / reasoning convergence.** AG-UI today carries two
   parallel hierarchies (`THINKING_*` and `REASONING_*`); the
   former is deprecated for 1.0 but still emitted by some upstreams
   (Anthropic extended thinking). When we onboard Anthropic-direct
   or another `THINKING_*` emitter, decide whether to map them onto
   `reasoning` or persist them as a sibling `thinking` type.
3. **Workflow `STEP_*` events.** ~~Persisting these would let
   `/admin/thread/[id]` render workflow runs as a timeline of steps.~~
   **CLOSED by D4a** — workflow forensics now flow through three
   dedicated `workflow_node_*` event types written directly by the
   engine (`emitEvent` → `workflow-run-recorder.ts`). AG-UI `STEP_*`
   frames remain dropped (see §8.2) because our workflow engine
   does not stream over AG-UI. The `/admin/run/[id]` page renders
   workflow timelines from the `workflow_node_*` rows; the
   `/admin/run` listing UI is still pending (D4b backlog).
4. **Retention cleanup.** `entity_run_event` is currently retained
   indefinitely; the schema doc references a 7-day horizon as the
   target. A periodic job (`DELETE WHERE ts < NOW() - INTERVAL '7
   days'` plus orphan reaping) is unwritten.
5. **Hot-path observability.** Persistence errors are logged but
   not aggregated. A counter on dropped events would surface a
   misbehaving DB before chat history goes mute.
6. **Eliminate `as BaseEvent` casts on the AG-UI event surface.** Plan in §11 below.

---

## 11. Future work — typed AG-UI event union

**Status:** designed, not yet implemented. Reviewer-flagged: 41 `as BaseEvent` casts across 6 files erase the precise types that `@ag-ui/core` already ships, breaking the project's "type-strict" baseline on the most critical hot path (event emit + persistence).

### 11.1 Problem

`@ag-ui/core` ships concrete typed events — `RunStartedEvent`, `TextMessageContentEvent`, `ToolCallArgsEvent`, etc. — each with a `type: z.ZodLiteral<EventType.XXX>` discriminant and a precise payload shape. But the bridge / runner code uses `BaseEvent` as the lowest common denominator and pays the cost twice:

**Write side (28 casts).** Authors write:
```ts
emit({ type: "RUN_STARTED", threadId, runId } as BaseEvent);
```
TypeScript would otherwise error twice: `"RUN_STARTED"` is a string literal but `BaseEvent.type` expects the `EventType` enum (TS treats string-enum members as branded), and `threadId / runId` aren't on `BaseEvent` (they're on `RunStartedEvent`). The cast silences both errors and the resulting object collapses to `{ type, timestamp?, rawEvent? }` — typos like `"RUN_STRATED"`, missing `messageId` on `TEXT_MESSAGE_START`, or `delta` written as `args` on `TOOL_CALL_ARGS` all compile cleanly.

**Read side (13 casts).** runner.ts / persisting-agent.ts use `event as BaseEvent & { delta?: unknown }` to peek at fields after `switch (event.type)`. With a proper discriminated union TypeScript would narrow automatically — these casts would simply not be needed.

Cast counts at design time:

| File | Count | Site |
|---|---|---|
| `lib/backends/bridge-runtime-kit.server.ts` | 6 | write |
| `lib/backends/agno/chat.server.ts` | 8 | write |
| `lib/backends/mastra/chat.server.ts` | 10 | write |
| `lib/backends/dify/chat.server.ts` | 4 | write |
| `lib/runner/runner.ts` | 4 | read |
| `lib/runner/persisting-agent.ts` | 9 | read |

### 11.2 Why not factory functions

Reviewer suggested `createRunStartedEvent(threadId, runId)` etc. Acceptable but suboptimal:

1. Reinvents `@ag-ui/core` shapes — the PR-vendored event types ARE the schema; wrapping them adds indirection without value.
2. Solves only the write side (28 of 41 casts); the 13 reader casts in runner / persisting-agent stay.
3. Ongoing maintenance: 15+ helpers, one per AG-UI event type, drift risk every time AG-UI adds an event.

### 11.3 Decision: discriminated-union `emit` parameter

Define a project-local union `AgUiEvent` covering every concrete event type, type the bridge `emit` callback as `(event: AgUiEvent) => void`, and write events as plain object literals using `EventType` enum for the discriminant. TypeScript narrows on `switch (event.type)` so reader-side casts vanish too.

```ts
// lib/copilot/index.server.ts (vendor-lockin barrel — see AGENTS.md §3.2 #8)
import type {
  RunStartedEvent, RunFinishedEvent, RunErrorEvent,
  TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent, TextMessageChunkEvent,
  ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent,
  ReasoningStartEvent, ReasoningEndEvent,
  ReasoningMessageStartEvent, ReasoningMessageContentEvent, ReasoningMessageEndEvent,
} from "@ag-ui/core";

export type AgUiEvent =
  | RunStartedEvent | RunFinishedEvent | RunErrorEvent
  | TextMessageStartEvent | TextMessageContentEvent | TextMessageEndEvent | TextMessageChunkEvent
  | ToolCallStartEvent | ToolCallArgsEvent | ToolCallEndEvent | ToolCallResultEvent
  | ReasoningStartEvent | ReasoningEndEvent
  | ReasoningMessageStartEvent | ReasoningMessageContentEvent | ReasoningMessageEndEvent;

export { EventType } from "@ag-ui/core";
```

Write site after migration:
```ts
emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
// no cast; missing fields / typoed type / wrong field name → compile error
```

Read site after migration:
```ts
switch (event.type) {
  case EventType.TEXT_MESSAGE_CONTENT:
  case EventType.TEXT_MESSAGE_CHUNK:
    summary += event.delta;          // narrowed automatically; no cast
    break;
  case EventType.RUN_ERROR:
    errorMessage = event.message;    // narrowed automatically; no cast
    break;
}
```

### 11.4 Hard decisions (locked)

| Question | Decision | Why |
|---|---|---|
| Factory functions vs typed union | **Typed union** | Solves both write and read sides, zero new helpers, mirrors how `@ag-ui/core` already models events. |
| Where does `AgUiEvent` live | **`lib/copilot/index.server.ts` barrel** | Already the project's vendor-lockin choke point for `@ag-ui/*` (AGENTS.md §3.2 #8). New union belongs with `BaseEvent` re-export, not as a new top-level module. |
| `EventType.RUN_STARTED` enum vs `"RUN_STARTED"` string literal | **Enum** | TS string-enum branding makes the bare string non-assignable to `EventType.RUN_STARTED` despite identical runtime value. The whole reason 28 write-site casts exist today is that authors wrote bare strings. |
| `BaseEvent` import everywhere | **Keep available, narrow `emit`** | `BaseEvent` is still a valid public type for code that genuinely is event-shape-agnostic (e.g. middleware that passes events through). Don't blanket-rename. The change is `emit: (event: BaseEvent) => void` → `emit: (event: AgUiEvent) => void`, plus the cast removals. |
| Schedule | **Land before next backend platform** | Adding a 4th provider chat handler with the current pattern would mean ~10 new casts and another fragile chat.server.ts. Fix the foundation first. |

### 11.5 Open questions

- **`THINKING_*` events.** `runner-events.md` §10 #2 mentions Anthropic-style extended thinking lands as `THINKING_*` in some upstreams. Check whether `@ag-ui/core` exports `ThinkingTextMessageStartEvent` etc. and include them in the union if so. Verify at implementation time.
- **`STEP_STARTED` / `STEP_FINISHED`.** Currently dropped by `PersistingAgent` (§10 #3). Include in `AgUiEvent` for future-proofing even though no consumer reads them yet.
- **Custom / raw events.** `@ag-ui/core` exports `CustomEvent` and `RawEvent` for provider-specific extensions. Decide whether they go in `AgUiEvent` (pro: writers can emit them without cast) or stay as escape-hatch separate types (pro: signals they're outside the standard set).

### 11.6 Implementation plan — phased

Single big-bang PR is too risky: 41 sites across 6 files including 3 provider chat handlers, and removing casts will surface real schema bugs that the casts have been hiding.

| PR | Scope | Files | Risk | Status |
|---|---|---|---|---|
| 1 | Add `AgUiEvent` union + `EventType` re-export to barrel. Pure addition; no consumer yet. | `lib/copilot/index.server.ts` | Zero — additive. | ✅ landed in `940f1b9` |
| 2+3 | Convert `bridge-runtime-kit.server.ts` AND provider chat handlers in one go. **PR 2 and PR 3 in the original plan could not be split**: the moment `BridgeRunContext.emit` and `TextStreamState.ctor` parameter types tightened from `BaseEvent` to `AgUiEvent`, all 22 cast sites in agno + mastra + dify broke simultaneously. Function-parameter contravariance means a tighter parameter type in the shared interface forces every consumer to update at the same time. | 4 files, 28 casts (6 + 22) | Medium — and as predicted, exposed 5 real schema bugs the casts had been hiding. Triaged in commit body. | ✅ landed in `<this PR>` |
| 4 | Convert reader sites: `runner.ts` + `persisting-agent.ts`. Replace `as BaseEvent & {...}` with switch-narrowed access. Single boundary cast `as AgUiEvent` at each subscriber callback's parameter, then per-case fields narrow automatically. | 2 files, 13 casts | Medium — touches event persistence. | ✅ landed in `<this PR>` |
| 5 | ESLint `no-restricted-syntax` rule banning `as BaseEvent` and `as BaseEvent & {...}` so the regression cannot sneak back in. | `eslint.config.mjs` | Zero — additive guard. | ✅ landed in `<this PR>` |

**Migration complete.** Zero `as BaseEvent` casts in `src/` (the only remaining matches are in explanatory comments). Two boundary casts remain: `runner.ts` (sync + async paths) and `persisting-agent.ts` each have ONE `as AgUiEvent` at the subscriber callback's `BaseEvent` parameter — the upstream contract `Observable<BaseEvent>` cannot be tightened from inside the consumer. These three boundary casts are explicitly commented and are the migration's irreducible cost.

**Note on the PR 2/3 merge:** the original plan assumed bridge-runtime-kit could land independently of the chat handlers. That was wrong because `BridgeRunContext.emit` is a *shared* contract — once its parameter type narrows, every call site that goes through that contract has to upgrade at the same time. Future plan splits should account for parameter-position contravariance: a shared input type cannot be tightened in isolation.

#### Schema bugs surfaced (PR 2+3)

The casts had been silencing five required-field violations against the `@ag-ui/core` Zod schemas:

| Site | Missing field | Fix |
|---|---|---|
| `agno/chat.server.ts` REASONING_START | `messageId` | New `reasoningSpanId = randomUUID()` reused for both REASONING_START/END and the inner MESSAGE_*. |
| `agno/chat.server.ts` REASONING_MESSAGE_START | `role: "reasoning"` literal | Added the literal explicitly. |
| `agno/chat.server.ts` REASONING_END | `messageId` | Same span id as START. |
| `mastra/chat.server.ts` TOOL_CALL_RESULT | `messageId` | Synthesised `msg_${input.runId}` (consistent with mastra's text-message convention). |
| `dify/chat.server.ts` TOOL_CALL_RESULT | `messageId` | Same convention as mastra. |

None of these had end-user-visible failure modes — the persistence layer (`PersistingAgent`) reads only the fields it needs and ignores the rest, and the browser AG-UI consumer is similarly tolerant via Zod passthrough. But they were emitted-but-malformed events that any strict downstream consumer (a future logging pipeline, an external observability tool, a different `@ag-ui/core` version with stricter parsing) would have rejected. Triaging at the type level beats discovering the violation at integration test time.

### 11.7 Migration

No data migration. No schema change. No public API change (the wire shape over SSE is identical — `JSON.stringify(event)` produces the same bytes whether `event` is typed `BaseEvent` or `AgUiEvent`). Pure compile-time tightening.

---

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
