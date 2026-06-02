# Nango Orchestrator (`南瓜`) — Design Plan

Status: **In progress** — P0, P1, P2 complete; P3 partially complete
(13 done, 14–15 pending); P4 pending.

This document started life as a design discussion held on 2026-04-30
and has been kept in sync with the implementation as each phase
landed. Sections still labelled "(proposed)" are unimplemented or
forward-looking.

Runtime boundary (v1): the orchestrator runs in Nango's
**single-instance** app process. Do not enable automatic
multi-replica scaling for this runtime. Heavy / distributed work
should be delegated to backend agent platforms; built-in agents are a
lightweight orchestration complement. Positioning is
**single-node multi-tenant** for personal and small-team usage; tenant
isolation and lifecycle capabilities will continue to evolve.

---

## 1. Vision

Set up a single **super agent** ("`南瓜` / Nango") as the user's default
entry point. It owns four responsibilities:

1. **Intent recognition** — understand what the user wants.
2. **Routing** — answer directly when capable; otherwise pick the most
   suitable backend / built-in agent for the job.
3. **Tracking** — observe the delegated work end-to-end.
4. **Reporting** — verify and summarise results back to the user in its own
   voice / persona (configured via system prompt).

Nango is a **bridge between the user and the pool of agents**, not a router
that disappears after handoff.

### Why not OpenAI Swarm-style handoffs as the default

| Need                              | Swarm Handoff | Tool-call Delegation |
| --------------------------------- | ------------- | -------------------- |
| Persona continuity                | Lost          | Preserved            |
| Verification / acceptance         | Hard          | Natural              |
| Multi-step / fan-out coordination | Awkward       | Clean                |
| Heterogeneous backend protocols   | Hard          | Clean                |
| Fits Nango's AG-UI front-end      | No            | Yes                  |

Conclusion: **tool-call delegation is the primary pattern**. Handoff stays
available as a *user-driven* mode (see §4) but is not Nango's default.

---

## 2. Core Architectural Lift: Task / Run as a First-Class Citizen

Every act of "let agent X do thing Y" — whether synchronous, background, or
scheduled — is materialised as a **`entity_run` row** and dispatched by a
single **`Runner`**. Different orchestration modes only differ in
*how the run is created* and *how its result is consumed*.

This mirrors Temporal / LangGraph / Inngest / Agno Workflows.

### Data model (proposed)

```ts
// entity_run — one execution of an entity (agent / team / workflow).
// All modes share this table.
{
  id, parentRunId?,                  // parent for fan-out / debate
  threadId,                          // the user-facing conversation
  initiator: "user" | "orchestrator" | "schedule" | "system",
  entityId,                          // EntityDescriptor.id
  entityKind: "agent" | "team" | "workflow",
  entitySource: "backend" | "builtin",
  credentialId,                      // backend only
  mode: "sync" | "async" | "scheduled",
  status: "queued"|"running"|"awaiting_input"|"paused"|"succeeded"|"failed"|"cancelled",
  inputTask, inputContext?, inputParams?,
  outputSummary?, outputArtifacts?,
  errorMessage?, errorDetails?,
  ownerId,                           // cascade-deleted; visibility = owner-only
  startedAt, finishedAt, deadline?,
  createdBy, createdAt
}

// entity_run_event — append-only stream (retain ~7 days)
{ runId, seq, type, payload, ts }
//   type: started | message | reasoning
//       | tool_call_chunk | tool_call_result
//       | final | error
//
// `message` / `reasoning` / `tool_call_chunk` payloads carry the
// FULL coalesced text/args for one continuous segment (between
// boundaries or message-id changes), not per-token deltas. AG-UI's
// TEXT_MESSAGE_CONTENT / REASONING_* / TOOL_CALL_ARGS events are
// buffered in PersistingAgent and flushed to a single row at each
// natural boundary — a 500-token reply produces 1 row, not 500. The
// browser still sees real-time deltas on the wire.
//
// Tool calls land as TWO rows representing two genuinely separate
// lifecycle stages — `tool_call_chunk` (the call decision: LLM-side
// "I want to invoke X with args Y", synthesised from AG-UI's
// TOOL_CALL_START + N×TOOL_CALL_ARGS + TOOL_CALL_END trio) and
// `tool_call_result` (the call execution: upstream tool's textual
// response, from TOOL_CALL_RESULT). A `tool_call_chunk` without a
// matching `tool_call_result` is the durable signal of "tool was
// invoked but never produced output" (timeout, agent died, or
// backend skipped the result emit) — the admin run detail page
// flags those rows in amber. The chunk naming aligns with AG-UI's
// `TOOL_CALL_CHUNK` single-event variant; we don't currently
// consume it (no upstream provider emits it), but the schema name
// keeps a future direct-CHUNK consumer straightforward to add.
//
// For the full event pipeline (reception → coalescing → persistence
// → conversation linkage → replay → admin display), the AG-UI
// EventType ↔ EntityRunEventType cross-reference, and per-type
// payload shapes, see `docs/runner-events.md`.

// schedule — recurring or one-shot trigger (P2 — shipped).
// Table name is "schedule" (NOT "entity_schedule"); cron is
// intentionally absent — see §5 for why we expose calendar units.
{
  id, ownerId, createdBy,
  entityId, entityKind, entitySource,    // EntityDescriptor projection
  credentialId, sourceLabel,             // backend dispatch + display
  name, task, timezone,                  // human-facing
  startAt,                               // first fire (required)
  intervalValue, intervalUnit,           // both null → one-shot;
                                         // unit ∈ minute|hour|day|week|month
  endAt,                                 // optional cap on recurring
  enabled,
  lastTriggeredAt, lastError,            // summary fields denormalised
                                         // onto the row so the panel can
                                         // render the status icon + the
                                         // supervisor list_schedules tool
                                         // can answer "did it just fail?"
                                         // without joining entity_run. Full
                                         // run history is reachable via
                                         // entity_run.schedule_id (see the
                                         // RecentRuns panel in ScheduleEditor).
  createdAt, updatedAt
}
```

### Unified Runner (shipped API)

```ts
interface Runner {
  runChatRequest(request: Request, input: StartRunInput): Promise<Response>;
  runBuiltinChatRequest(
    request: Request,
    args: RunBuiltinChatRequestArgs,
  ): Promise<Response>;
  start(input: StartRunInput): Promise<ProgrammaticRunResult>;
}
```

`await(runId)`, `cancel(runId)`, and `status(runId)` were part of the
early proposal but are **not** in the current v1 Runner contract. Real-time
terminal updates are surfaced through `/api/runs/stream` SSE +
`notification` rows; run state is read from `entity_run`.

There is exactly **one** Runner implementation. Internally it dispatches by
`entitySource`:

- `backend` → call the platform's `IBackendChatHandler.buildAgent()` to
  get an `AbstractAgent`, wrap with a `PersistingAgent` decorator that
  tees AG-UI events into `entity_run_event`, plug into the AG-UI runtime.
- `builtin` → (P0 step 4) call the in-process CopilotRuntime via
  `agentPool.get(id)`, same persistence wrapper.

`entityKind` (agent / team / workflow) drives upstream URL choice
*inside* the per-platform handler (e.g. agno's `/agents/{id}/runs` vs
`/teams/{id}/runs`); the Runner itself doesn't branch on kind.

All consumers (sync wait, async notification stream, scheduled trigger,
debate coordinator) work against the same Runner API.

### CopilotKit's Role: Protocol Adapter, Not Dispatch Engine

> **Principle.** CopilotKit is Nango's *presentation + protocol layer*.
> It is **not** the dispatch engine, the orchestration kernel, or the
> source of truth for agent state. All agent → agent invocation,
> scheduling, async background work, and run lifecycle goes through
> Nango's own `runner.start(...)` pathway. CopilotKit only handles the
> HTTP/SSE adaptation for the chat surface.

This is sometimes called **"Framework Degradation"** or running an
**"edge framework"** — we intentionally use CopilotKit at the edges of
the system (protocol + UI components) rather than at the core
(orchestration). We chose CopilotKit for:

- Its first-rate React UI library (`<CopilotChat>`, `useAgent`, etc.).
- The AG-UI streaming protocol it implements end-to-end.

We did **not** choose it for its dispatch / multi-agent / state-machine
capabilities, and we deliberately do not route those through it.

#### Dual entrypoints, single core

```
       Chat (HTTP/SSE)                Delegation / Schedule / Async
              │                                    │
              ▼                                    ▼
   CopilotKit runtime layer               runner.start({...})
   (HTTP request → AG-UI SSE)             (programmatic dispatch)
              │                                    │
              └──────────────┬─────────────────────┘
                             │
                             ▼
              PersistingAgent (wraps inner agent)
                             │
                             ▼
            inner AbstractAgent.run(input)
              • BackendBridgeAgent (agno / Mastra / Dify)
              • BuiltInAgent (CopilotKit's own class)
                             │
                             ▼
            entity_run + entity_run_event (SoT)
```

The two entrypoints adapt different *callers* (an HTTP/SSE client vs.
in-process server code), but converge on **`PersistingAgent` + the
`entity_run` family of tables** — this convergence is the actual core
abstraction, not either of the adapters.

#### Why not collapse to CopilotKit's `agents: Record<...>` runtime

CopilotKit v2's multi-agent map is designed for **HTTP routing** (URL
path `<basePath>/agent/<id>/run` looks up `runtime.agents[id]`). Forcing
all of Nango's orchestration through it would require:

1. **Headless tasks fight the SSE lifecycle.** CopilotKit's runtime
   lifecycle is bound to a live HTTP SSE connection. Scheduled cron
   jobs, async background runs, and webhook-triggered work have no
   such connection — they need to run, finish, and write
   `entity_run`-side, all without a browser client. The Nango model
   ("dispatch returns `runId`, results land in DB, user reads them
   later") is fundamentally a server-side primitive; pushing it
   through an HTTP SSE adapter is a category error.

2. **Eager-loading explodes under multi-tenancy.** CopilotKit's
   in-process routing requires the `agents` map to be populated
   *before* dispatch — meaning every user's every visible agent must
   be eagerly instantiated per request. Nango agent construction is
   expensive (MCP server borrow via `mcpProviderPool`, spec resolve,
   prompt composition, supervisor catalog inlining, datasource policy
   load). A user with 50 visible agents would pay 50× build cost per
   request for one chat. The current "lazy build only the targeted
   agent" model is unworkable through CopilotKit's map; we'd have
   to subvert the framework with a factory that builds N-1 stubs.

3. **Observability becomes a black box.** Nango persists every
   dispatch as an `entity_run` row, tags Langfuse traces, enforces
   per-resource RBAC, captures degradation events at build time, and
   threads `parent_run_id` so supervisor → sub-run trees are
   queryable. All of this lives in one place because dispatch goes
   through a single `runner.start(...)` entrypoint we own. Routing
   server-side dispatch through CopilotKit's internal map would
   require either (a) monkey-patching its dispatch path with
   middleware hooks, or (b) reimplementing run-lifecycle bookkeeping
   on both sides — both are fragile and one CopilotKit minor version
   bump away from breaking.

4. **CopilotKit assumes it's the engine. Nango isn't.** Nango is a
   heterogeneous agent platform — built-in agents (CopilotKit
   `BuiltInAgent`), backend agents (agno, Mastra, Dify), and (future)
   more. CopilotKit doesn't know about Dify's `conversation_id`, agno's
   session_id, Mastra's memory thread — those mappings live in
   `backend_thread_state` and the per-backend bridge agents. Putting
   CopilotKit at the center would force every new backend integration
   to graft itself onto CopilotKit's abstractions; putting it at the
   edge (as adapter) keeps every backend on equal footing under the
   Nango kernel.

5. **The CopilotKit API doesn't expose server-side invocation as
   first-class.** There is no `runtime.invokeAgent(id, input):
   Observable<Event>` public API. To call an agent server-side without
   an HTTP request you'd either fabricate a fake `Request` object and
   feed it to `createCopilotRuntimeHandler`, or reach into the
   `agents` map directly and call `.run()` — both subvert the
   framework. CopilotKit's design intent is "HTTP request enters →
   SSE response exits"; anything else is misuse.

#### The boundary in concrete terms

| Concern | Owner |
|---|---|
| Chat HTTP/SSE protocol encoding | **CopilotKit runtime** (`runWithAgents` / `createCopilotRuntimeHandler`) |
| AG-UI event schema | **CopilotKit / AG-UI client library** |
| `<CopilotChat>` React surface | **CopilotKit react-core v2** |
| Per-thread agent clone caching (in-browser) | **CopilotKit `useAgent` WeakMap** |
| Inner agent execution (`agent.run`) | **Bridge agents (Nango)** + **BuiltInAgent (CopilotKit class)** |
| **Event persistence** | **Nango `PersistingAgent` + `entity_run_event`** |
| **Run lifecycle** | **Nango `runner.start`/`runChatRequest` + `entity_run`** |
| **Supervisor delegation** | **Nango `runner.start({mode: "sync"})`** (does not touch CopilotKit runtime) |
| **Scheduled / async dispatch** | **Nango `runner.start({mode: "async"})` + `scheduler.ts`** |
| **Workflow agent-node dispatch on refresh** | **Nango `runner.start({mode: "sync"})`** from `lib/artifacts/execute-workflow.ts::buildRealRunAgent` (W2; only on `forceFresh: true`) |
| **Parent-child run tree** | **Nango `entity_run.parent_run_id`** |
| **RBAC, audit, Langfuse trace** | **Nango (in `runner.start` and route handlers)** |
| **Cross-backend session tokens** (Dify conv_id etc.) | **Nango `backend_thread_state`** |

#### Practical rules

- **Adding a new agent type / backend?** Add a `BridgeAgent` (an
  `AbstractAgent` subclass) + a chat handler. Do *not* touch
  CopilotKit's runtime configuration.
- **Adding a new dispatch trigger** (webhook, event bus, …)? Wire it
  through `runner.start(...)`. Do *not* route it through a fake
  HTTP request to the CopilotKit runtime.
- **Need a server-side agent to call another agent?** Use the
  supervisor pattern — `runner.start({mode: "sync"})` returns the
  final assistant text. Do *not* construct a fake Request and call
  the CopilotKit handler.
- **Need a UI feature CopilotKit doesn't provide?** Add it to Nango's
  surface (`ChatPanel.tsx`, `ChatViewShell`, etc.). The CopilotKit
  React layer can be wrapped, slotted, or sidestepped freely.
- **CopilotKit minor version upgrade breaks something internal?**
  The blast radius is limited to the adapter layer
  (`lib/copilot/`, `lib/backends/runtime.server.ts`,
  `app/api/copilotkit/...`). The kernel
  (`lib/runner/`) is by design independent.

---

## 3. Mode Registry (Open–Closed)

```ts
interface OrchestrationMode {
  id: string;                                  // "tool-call" | "handoff" | "auto" | ...
  label: string;
  description: string;
  applicability(ctx): boolean;                 // gate by context (e.g. ≥2 agents for debate)
  initiate(ctx, userMsg): Promise<ModeOutcome>;
}
```

The user-facing mode switch in the chat input is a **render of the
registry**. Adding a new mode = registering one item; the UI requires no
code change.

### Shipped modes (`lib/orchestration/modes.ts`)

The mode the user picks in the chat input drives a `promptDirective`
appended to the supervisor's system prompt at dispatch time. `auto`
is the default — the supervisor decides between delegating, handing
off, or going async based on the prompt SOP.

| Mode          | How a Task is created                                                                 | How it's consumed                                              | Nango's role            |
| ------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------- |
| **auto**      | Supervisor chooses tool-call / handoff / async per the prompt SOP                     | (see chosen sub-mode)                                          | dictated by SOP         |
| **tool-call** | `delegate_to_agent` tool → `runner.start({mode: "sync"})`                             | LLM awaits final event; result feeds back into the chat        | always present          |
| **handoff**   | **Frontend tool** `switch_agent_with_context` (registered via `useFrontendTool` in `hooks/useHandoff.ts`): mutates the workspace store → `<CopilotKitProvider>` remounts on the target agent (its `key={copilotKey}` includes `agentId`; see `docs/copilotkit-provider-lifecycle.md`) → `useInjectHandoffContext` primes the new thread with `contextSummary` and dispatches a run | Target agent takes over the conversation directly              | exits, recall available |
| **async**     | `delegate_async` tool → `runner.start({mode: "async"})` returns `runId` immediately   | Notification tray + SSE; user gets a bell entry on completion  | dispatches & broadcasts |

`scheduled` and `debate` are not user-selectable modes — they are
separate machinery driven by the supervisor's tool surface
(`create_schedule`) and by P3.14 (pending) respectively. Each
fires through `runner.start` like any other run.

> **Note**: `handoff` is *not* a Swarm-style runtime control transfer.
> It is a **UI-level agent switch with context transcription**. This
> avoids cross-protocol handoff complexity.

---

## 4. Long-Running Tasks & Notifications (shipped)

When `mode = async`:

1. `runner.start({ mode: "async" })` returns a `RunHandle` immediately
   (`{ runId, status: "running" }`); the run executes in the same Node
   process via the existing `PersistingAgent` subscription path.
2. The runner publishes events to an in-process `EventBus`
   (`lib/runner/event-bus.ts`, keyed by `ownerId` and held on
   `globalThis` so HMR doesn't fragment subscribers).
3. The browser subscribes via SSE (`/api/runs/stream`) to receive
   `notification` and `run_finalized` frames in real time. Each
   `notification` frame ships with `id: <notification.id>` (UUIDv7),
   so EventSource auto-reconnect uses `Last-Event-ID` to resume; the
   handler runs `WHERE owner_id = $u AND id > $lastId ORDER BY id
   LIMIT 200` against the `notification` table and de-duplicates
   live-during-replay events by id before switching back to live.
   `run_finalized` carries no `id:` because it has no durable copy —
   the matching `notification` row is what survives a brief gap.
   Multi-tab sync is achieved with a
   `BroadcastChannel("nango.notifications")`.
4. On terminal events the runner inserts a `notification` row
   (kind = `run_completed | run_failed`) and broadcasts it. The bell
   dropdown caps at 6 rows; the full `/notifications` page is the
   long-form inbox.
5. At Next.js boot, `recordProcessBoot()` writes one row to
   `process_boot` capturing `started_at`, then
   `recoverStrandedRuns(boot.startedAt)` (in `instrumentation.ts`)
   flips any `running` run with `started_at < boot.startedAt` to
   `failed` and emits a `run_failed` notification — those rows are
   by definition zombies left by a prior process. Users see the
   notification within seconds of redeploy instead of waiting an
   hour for the previous coarse heuristic to trigger.

> Nango holds **only the `runId`** in the main conversation context — never
> the run's intermediate output — so long tasks do not bloat the session.

---

## 5. Scheduling (shipped)

A single in-process `setTimeout`-based scheduler covers all backends
uniformly. The user-facing trigger spec is intentionally cron-free —
`(startAt, [intervalValue, intervalUnit], [endAt])` where unit is one
of `minute | hour | day | week | month`. Three valid shapes:

| `startAt` | `interval` | `endAt` | meaning              |
|-----------|------------|---------|----------------------|
| ✓         | —          | —       | one-shot             |
| ✓         | ✓          | —       | recurring, no end    |
| ✓         | ✓          | ✓       | recurring, bounded   |

Why not cron / agno-native:

- The trigger spec users want to express ("every 7 minutes", "every
  2 weeks", "every 6 months at 09:00 EDT") is straightforward to
  compute with a `setTimeout` walk over a calendar but awkward to
  shoehorn into 5-field cron.
- Wrapping per-platform schedulers (agno native + cron fallback)
  doubles the failure surface and forces UI to either lowest-common-
  denominator or expose platform leakage. Single in-process scheduler
  + `runner.start({ mode: "async", initiator: "schedule" })` keeps
  every fire on the same code path as user-initiated async
  delegation, so scheduled runs land in the notification inbox for
  free.

Implementation: `lib/runner/scheduler.ts`. State is held in a
`globalThis` slot (HMR-safe) — one `setTimeout` per enabled `schedule`
row. Boot-time `bootstrapScheduler()` (called from
`instrumentation.ts`) re-arms every enabled row. No retries: a
failure records `lastError` and the next tick is independent.

Surface:

- REST: `/api/schedules` (list/create), `/api/schedules/[id]`
  (patch/delete), `/api/schedules/[id]/trigger` (manual fire).
- Supervisor tools: `create_schedule`, `list_schedules`,
  `update_schedule`, `delete_schedule`. `update_schedule` is partial
  and stricter than the REST PATCH route — a `startAt` in the past
  is rejected so the LLM can't backfill. `delete_schedule` is
  hard-delete; pause-without-delete is `update_schedule({enabled:
  false})`.
- UI: left `Schedules` panel (list-only) + `/schedule/[id]` editor.

---

## 6. Discussion / Debate Mode (proposed — P3.14 / P3.15 pending)

Powered by the same Task model:

- Parent run: a debate-coordinator agent (separate built-in role).
- Each round fans out child runs (`runner.start` in parallel).
- Coordinator reads each child's `final_summary`, decides next speaker /
  termination, modelled on **AutoGen GroupChatManager** + **CrewAI
  hierarchical process**.
- UI: a roundtable view rendering the parent run + its children.

The recursion-depth limit (§8.1) and the `parent_run_id` chain
already in place are sufficient for the parent / fan-out shape; the
gating work is the coordinator built-in role plus the roundtable
component, both still pending.

---

## 7. Future work

Everything described in §1–§6 has shipped. The list below is the
remaining backlog.

### Multi-Agent Collaboration

- **Debate / discussion coordinator** — multi-specialist back-and-forth
  with a structured turn protocol, on top of the existing parent-child
  run forest.
- **Roundtable UI** — surface the multi-specialist forest as a single
  visual instead of nested task cards.

### Governance

- **Quotas / rate limits / cost tracking.** CopilotKit's
  `BuiltInAgent` currently swallows the AI SDK `usage` field, so
  token counts require either a fork or per-platform bridges (Dify
  already exposes usage). Wall-clock timing (TTFT, duration,
  inter-event gaps) is already captured authoritatively on
  `entity_run` + `entity_run_event` and surfaced by
  `/admin/thread/[id]`; a dedicated performance view on top of that
  data is future work.
- **Run replay** — re-render an `entity_run` from its
  `entity_run_event` timeline (debug + audit).
- **Working memory across runs** — Nango remembering prior
  delegations. Tracked separately in `docs/memory.md`; deferred
  pending product signal.

---

## 8. Hard invariants

1. **Recursion depth** — `parentRunId` chain limited to 3. Orchestrator
   delegating to another orchestrator → reject.
2. **Cancellation** — main chat cancellation cascades to child runs in
   `queued` / `running` state via `AbortSignal` plumbed through to
   backend handlers.
3. **Ownership** — `entity_run.ownerId` is mandatory; all APIs must filter
   by it. Async run visibility = run owner, **not** agent owner.
4. **Retries** — Runner does **not** auto-retry (avoids re-firing
   side-effecting tools). Nango's SOP decides whether to retry / switch
   agent.
5. **Event retention** — target horizon for `entity_run_event` is
   ~7 days; the durable summary survives in `entity_run.outputSummary`.
   The actual cleanup job is not yet shipped — see
   `docs/runner-events.md` §10 (open questions). When implemented it
   should also drop matching `notification` rows whose `run_id` no
   longer resolves.

---

## 9. Chat History — Replay From `entity_run_event`

The orchestration kernel and the user-facing chat history are the
**same** tables. Built-in and backend agents share one PG-side
history source (no per-platform `/sessions` reverse-proxy any more).

Endpoints (all owner-scoped via `eq(entityRun.ownerId,
session.user.id)`):

| Endpoint | Behaviour |
|---|---|
| `GET /api/threads` | List the user's threads (one row per `thread_id`), most-recent first. Optional `?entityId=` filter. |
| `GET /api/threads/[id]/messages` | Reconstruct AG-UI `Message[]` from `entity_run.input_task` (user turns) + `entity_run_event` (assistant / reasoning / tool turns). |
| `DELETE /api/threads/[id]` | Recursive CTE walks the run forest and removes top-level + delegated sub-runs together. |

Sub-runs from supervisor delegation are **excluded** from these
reads (`parent_run_id IS NULL`) — the user-facing chat surface stays
uncluttered while admins still see the full forest at
`/admin/thread/[id]`. Client hydration on page load goes through
`useThreadHydration`, which calls `agent.setMessages(...)` on the
`<CopilotChat>` component's first mount per `(agentId, threadId)` so
refresh / history-click resumes mid-conversation.

The full event-to-`Message[]` projection (including how
`tool_call_chunk` / `tool_call_result` rows compose into AG-UI tool
calls, and which AG-UI events are coalesced vs dropped on the way
in) lives in `docs/runner-events.md` §6.

---

## 10. Historical: Backend Transport Refactor

A prerequisite for the runner / orchestrator work was making the
backend integration layer transport-agnostic. The decision —
**REST-first, AG-UI internally** — has shipped; this section is
retained as the rationale of record. The current adapter shape and
provider walkthroughs live in `docs/backend-integration.md`.

Decision in one line: every chat handler emits AG-UI events (the
canonical event vocabulary), but the wire protocol used upstream
is REST + SSE. AG-UI stays the protocol between the browser and
`/api/copilotkit*`, the event model for `entity_run_event`, and the
output type of every `IBackendChatHandler` — but no longer
constrains how the bridge talks to the upstream platform.

Why it was needed:

- Dify (and future Coze / FastGPT / AnythingLLM) don't speak AG-UI;
  REST bridges are required regardless.
- Management surfaces (sessions, schedules, teams, memory) go
  through REST anyway — keeping AG-UI as a second channel would
  split one platform across two protocols.
- Async / schedule / teams / debate features depend on REST-only
  capabilities AG-UI does not expose.

Outcome:

| Transport | Used by |
|---|---|
| `rest-sse-bridge` | agno, Mastra, Dify — every current platform |
| `agui-passthrough` | retained but unused; helper still in `runtime.server.ts` for any future direct-AG-UI provider |

`restUrl` on the credential row is treated as required by the chat
path; missing it is a 502.

### Reference reading

- Anthropic — *Building Effective Agents* (Orchestrator-Workers, Routing)
- OpenAI Agents SDK — handoff vs agent-as-tool
- LangGraph Supervisor / Subgraph / Parallelization examples
- AutoGen GroupChatManager (debate / discussion)
- Inngest / Trigger.dev (long-running run + event-stream patterns)
- CopilotKit CoAgents (multi-agent on the existing runtime)

---

## 11. Implementation Details and Quirks

### Runner Kernel (`runner.ts` / `types.ts`)
- **Architecture (chat path):** `runChatRequest(req, input)` → `recordRunStart` (status=running) → `handler.buildAgent` → `PersistingAgent` (tee to `entity_run_event`) → `runWithAgents` (single AG-UI runtime entry, shared with built-in dispatch; backend dispatches pass `trimMessages: true`).
- **Runtime Choice:** Uses `CopilotRuntime` (the compat shim that delegates to `CopilotSseRuntime` when `intelligence` is unset — always our case). We deliberately stay off Intelligence mode, because it requires CopilotKit's cloud + Redis locks, which contradicts our single-node multi-tenant positioning. Persistence is handled via PostgreSQL (`entity_run_event`). See "CopilotKit's Role" above.
- **Polymorphism by `credentialId`:** If `credentialId` is present, it's a backend entity (and `entityKind` is server-derived from `EntityCatalog`). If absent, it's a built-in entity (`entityKind` is implicitly `"agent"`). Note that `entityId` is not globally unique on its own (e.g. multiple Dify credentials each have an entity with id `"default"`); the unique key is `(credentialId, entityId)` for backend, or just `entityId` for built-in.
- **Security:** Entity `kind` is server-derived (`EntityCatalog.list(credentialId)` on the chat route; supervisor catalog / `schedule.entity_kind` on programmatic paths). The client cannot supply or override it. Cost is one cached lookup per dispatch (LRU TTL 10 min; cache is warmed by `WorkspaceProvider` on UI mount).

### Custom HTTP Headers

Only two custom HTTP headers cross the browser → server boundary on the chat routes. Both encode information the server genuinely cannot derive on its own. **Canonical names live in `src/lib/http/chat-headers.ts` (`CREDENTIAL_ID_HEADER`, `ORCHESTRATION_MODE_HEADER`); never write the string literals directly.**

| Header | Route | Sent when | Purpose | Server fallback |
|---|---|---|---|---|
| `X-Credential-Id` | `/api/copilotkit/...` (backend) | `agentSource === "backend"` | Identifies which credential the user picked. Cannot be server-derived: a single user can use any enabled credential (admin-managed, all shared), and `agentId` is not globally unique across credentials, so `(credentialId, agentId)` is the only way to disambiguate which backend to dispatch to. | None — required; route returns 400 if missing. |
| `X-Orchestration-Mode` | `/api/copilotkit/builtin/...` | `agentSource === "builtin"` | Carries the user's transient session preference (`auto` / `tool-call` / `handoff` / `async`). Only affects the supervisor agent's system prompt (mode directive suffix). | `auto` (registry default). |

Everything else flows through other channels:

- **`agentId`** — parsed from the URL path `/agent/<id>/<run|connect|stop>` (CopilotKit's convention). Both routes parse it server-side; no header involvement.
- **`entityKind`** — looked up server-side via `EntityCatalog.list(credentialId)` (backend route only; built-in agents are always `kind: "agent"`).
- **`userId`** — extracted from the session cookie by `withSession` middleware. Never trusted from any client field.
- **`forwardedProps.user_id`** in the AG-UI body — server-injected by `lib/runner/inject-user-id.ts` before the request reaches `CopilotRuntime`, overwriting whatever the client put there. Bridge agents (agno/Mastra/Dify) read it to scope their external session/memory.

The header set deliberately encodes "the user's choices" only — identity, credentials, and entity metadata are all server-owned. Adding a new header on these routes should be a high-bar decision; the question to ask is "is this a user choice I cannot derive server-side?"

#### Why headers, not body fields?

These two pieces of metadata could conceivably live in the AG-UI `RunAgentInput.forwardedProps` body field instead. We deliberately chose headers for four reasons:

1. **Semantic category** — `credentialId` and `orchestrationMode` are *routing dimensions*, not business data, in the same league as `Content-Type`, `Accept`, or `X-Tenant-Id`. By HTTP convention, routing metadata belongs in headers; the body is for the payload the route operates on.

2. **Middleware short-circuit** — `withSession`-style HOFs and our route-level validation read these values before the body is parsed. A missing credential or unknown mode can fail-fast (400 / 404) without consuming the request stream, which matters because `extractRunInput` also clones the body downstream; reading the body twice in the critical path is wasteful.

3. **AG-UI protocol decoupling** — putting Nango-specific routing fields into `forwardedProps` would either pollute AG-UI's body schema (CopilotKit owns that schema and may evolve it) or require fork-style additions. Headers are an orthogonal channel that the AG-UI protocol doesn't care about.

4. **CopilotKit SDK integration** — CopilotKit's client-side `HttpAgent.connect()` serialises `RunAgentInput` as the body verbatim. Adding a body field would require subclassing / forking `HttpAgent` on the browser side, whereas the `headers` option passes through cleanly.

When to revisit this: the headers approach scales fine up to ~3 routing dimensions. If we ever hit 5+ routing knobs, or any one of them gets a complex structured value (nested object / array), it's worth folding them into a single typed body object instead.

### Persistence (`persisting-agent.ts`)
- **Quirk (Coalescing Storage):** Storage is coalesced per *segment*, not per-token. AG-UI's `TEXT_MESSAGE_CONTENT` (and reasoning equivalents) arrive as one event per token. Persisting each as a row would spam `entity_run_event` (e.g. 500 rows for a 500-token reply). We buffer assembled text in memory and flush ONE row at each natural boundary (next tool call, message-id change, or stream end). The browser still sees real-time deltas on the wire.
- **Contract (Termination):** Finalizes the `entity_run` row exactly once:
  - Upstream complete (post-`RUN_FINISHED`) → `succeeded` (or `failed` if a `RUN_ERROR` occurred).
  - Upstream/Observable errors → `failed`.
  - Subscriber teardown (browser disconnect) → `cancelled`.
  In every termination arm, any pending message/reasoning buffer is drained first so partially-streamed text is preserved.
- **Cancellation Flow:** When the user closes the tab, CopilotRuntime tears down the subscription → `bridge-runtime-kit` aborts the upstream fetch → `finalize` flips the row from `running` to `cancelled`. This prevents rows from staying `running` for an hour until swept by the recovery job.
- **Security:** Persistence errors NEVER block the chat stream. DB writes are fire-and-forget so user-facing chat does not stutter for observability side-effects.

### Scheduler (`scheduler.ts`)
- **Quirk (Hand-rolled timer):** The scheduler is an in-process `setTimeout` timer, not cron. Schedules speak `(startAt, [intervalValue, intervalUnit], [endAt])`. State survives HMR via `globalThis`.
- **Contract:** One missed tick = one missed run; no retries. A failed fire records `lastError` and rearms for the next scheduled fire. Every fire goes through `runner.start({mode: "async", initiator: "schedule"})`, ensuring scheduled runs land in the same notification inbox as async delegations.

### Supervisor Tools (`supervisor-tools.server.ts`)
- **Quirk (Stateful Tool Closures):** `defineTool` `execute()` is a pure function. Per-user / per-run state is captured in the closure built per-request (`userId`, `supervisorAgentId`, and a mutable `parentRunIdHolder` cell that the runner sets after the `entity_run` row is created).
- **Security (Loop Prevention):** The routing catalog structurally excludes any agent with a non-null `role` (supervisor / secretary / evaluator), so system agents can never appear as delegation targets. Per-user uniqueness on supervisor / secretary prevents cross-supervisor cycles. The `parent_run_id` chain depth limit (configured in `event-store.ts`) acts as the final defense against infinite loops.

### Async & Recovery
- **Event Bus (`event-bus.ts`):** In-process pub/sub for runner-driven events. Uses an in-process `Map<userId, Set<Subscriber>>`—no Redis/broker needed. Subscribers are tied to live SSE connections, and disconnects MUST call the unsubscribe handle (via the `request.signal`'s abort listener) to prevent memory leaks.
- **Process Boot (`process-boot.ts`):** Records one row per Node process boot and caches `startedAt`. This anchor prevents the need for a coarse 1-hour heuristic when recovering stranded runs. Idempotent across instrumentation re-evaluation via a `globalThis` slot.
- **Recovery (`recovery.ts`):** Invoked by `instrumentation.ts` after recording the process boot. Any `entity_run` whose `started_at` is older than the new boot timestamp is a zombie from a prior process and is flipped to `failed`. Since the boot epoch is captured before the app accepts requests, there is no race window where a current-process run could be mistaken for a zombie.
