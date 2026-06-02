# Runner — Execution Kernel

> Audience: backend engineers working on agent dispatch and orchestration
> See also: `docs/orchestrator.md` (design vision), `docs/runner-events.md` (event pipeline)

---

## 1. Overview

The Runner is Nango's execution kernel. Every agent invocation — user
chat, supervisor delegation, async task, scheduled trigger — passes
through the Runner, which owns the full lifecycle:

```
Request → Authorization → Agent Build → Run Row → Dispatch → Events → Finalize → Notify
```

The Runner lives in `src/lib/runner/` (15 files, ~3600 lines) and is
a **single-instance, in-process orchestrator** (not a distributed
workflow engine). Heavy work is delegated to backend platforms; the
Runner is the dispatch + persistence + notification layer.

---

## 2. Architecture

```
                     User Chat          Supervisor Tool        Scheduler
                         │                    │                    │
                         ▼                    ▼                    ▼
                   ┌─────────────────────────────────────────────────┐
                   │                  Runner                         │
                   │                                                 │
                   │  runChatRequest()    start()     runBuiltinChat │
                   │      │                │               │        │
                   │      ▼                ▼               ▼        │
                   │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
                   │  │ Backend  │  │Programmatic│ │ Built-in     │  │
                   │  │ Dispatch │  │  Dispatch  │ │ Dispatch     │  │
                   │  └────┬─────┘  └────┬──────┘ └──────┬───────┘  │
                   │       │             │               │          │
                   │       ▼             ▼               ▼          │
                   │  ┌────────────────────────────────────────┐    │
                   │  │           PersistingAgent               │    │
                   │  │  (intercepts AG-UI events → DB rows)    │    │
                   │  └────────────────────────────────────────┘    │
                   │       │                                        │
                   │       ▼                                        │
                   │  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
                   │  │event-store│  │event-bus │  │notifications│  │
                   │  │(DB rows) │  │(pub/sub) │  │(inbox+SSE)  │  │
                   │  └──────────┘  └──────────┘  └─────────────┘  │
                   └────────────────────────────────────────────────┘
```

---

## 3. Entry Points

The Runner exposes three entry points via the `Runner` interface:

### 3.1 `runChatRequest(request, input): Response`

**Caller:** `/api/copilotkit/[...path]` route (backend agents).

Flow:
1. Resolve credential → get provider → get `ChatHandler`
2. `handler.buildAgent(ctx)` → `AbstractAgent` or `Response` (error)
3. Skip run lifecycle for bookkeeping paths (`/info`, `/threads/*`)
4. `extractRunInput(request)` — clone-and-parse to peek at task + threadId
5. `recordRunStart(seed)` → `entity_run` row in `running` state
6. Wrap agent in `PersistingAgent` (event interception)
7. `runWithAgents(request, { agents: { [id]: persistedAgent }, endpoint, runner, trimMessages: true, entitySource: "backend", diag })` → SSE response
8. On error: `finalizeRun(runId, "failed")`

### 3.2 `runBuiltinChatRequest(request, args): Response`

**Caller:** `/api/copilotkit/builtin/[...path]` route (built-in agents).

Flow:
1. Classify URL path → `{ agentId, action }` or `null` (info/threads)
2. Authorization: `isAgentVisibleTo` / `listVisibleAgentIds`
3. `buildBuiltinAgents(agentIds)` → agents + MCP borrows + degradations
4. If run request: `extractRunInput`, `recordRunStart`, wrap each agent in `PersistingAgent`
5. Build `CopilotSseRuntime` with agents map
6. `createCopilotRuntimeHandler(runtime)` → dispatch
7. If Langfuse enabled: `withTrace(dispatch)` else plain dispatch
8. `finally`: release MCP borrows + flush Langfuse

### 3.3 `start(input): ProgrammaticRunResult`

**Caller:** Supervisor tools (`delegate_to_agent`, `delegate_async`) and
scheduler.

Flow:
1. Resolve entity: built-in → `agentPool.get(id)`, backend → `EntityCatalog.list`
2. `recordRunStart(seed)` → `entity_run` row
3. Build agent (built-in: compose from spec; backend: `handler.buildAgent`)
4. Wrap in `PersistingAgent`
5. Execute `agent.run()` → collect AG-UI events into `summary`
6. `finalizeRun(runId, status)` + `recordRunNotification()`
7. Return `{ runId, status, summary }`

---

## 4. Key Components

### 4.1 PersistingAgent (`persisting-agent.ts`, 321 lines)

Decorator that wraps any `AbstractAgent` and intercepts AG-UI events
to persist them into `entity_run_event` rows.

```
AG-UI event stream
  ↓
PersistingAgent.run()
  ├── event.type === RUN_STARTED → recordEvent(runId, seq++, "started")
  ├── event.type === TEXT_MESSAGE_CONTENT → recordEvent(runId, seq++, "message")
  ├── event.type === TOOL_CALL_CHUNK → recordEvent(runId, seq++, "tool_call_chunk")
  ├── event.type === TOOL_CALL_RESULT → recordEvent(runId, seq++, "tool_call_result")
  ├── event.type === RUN_FINISHED → finalizeRun(runId, "succeeded") + recordEvent("final")
  └── event.type === RUN_ERROR → finalizeRun(runId, "failed") + recordEvent("error")
```

The agent delegates all non-`run()` methods (name, description,
threadId, setMessages, etc.) to the inner agent transparently.

### 4.2 Event Store (`event-store.ts`, 161 lines)

CRUD for `entity_run` + `entity_run_event` tables:

| Function | Purpose |
|---|---|
| `recordRunStart(seed)` | Insert row in `running` state; checks recursion depth |
| `finalizeRun(runId, status, fields)` | Idempotent: only writes when status is still `running` |
| `recordEvent(runId, seq, type, payload)` | Insert event row (lock-free, seq monotonic) |
| `readEvents(runId)` | Full timeline for admin forensics |

**Recursion depth guard:** `MAX_RECURSION_DEPTH = 3`. Before creating a
run with a `parentRunId`, walks the parent chain to count depth. Throws
`RecursionDepthExceeded` if exceeded — prevents supervisor delegation
loops.

### 4.3 Event Bus (`event-bus.ts`, 77 lines)

In-process pub/sub keyed by `ownerId`:

```typescript
subscribe(ownerId, callback) → unsubscribe
publish(ownerId, event)
```

Used by `/api/runs/stream` (SSE) to push real-time notifications to the
user's browser. Events: `run_finalized`, `notification`.

Properties:
- Throwing subscriber doesn't block others (catch + continue)
- No-op when nobody listens (DB is the source of truth)
- HMR-safe via `globalThis` symbol slot

### 4.4 Notifications (`notifications.ts`, 110 lines)

Generates `notification` table rows for terminal run events:

| Function | Purpose |
|---|---|
| `previewBody(text)` | Sanitize (strip NUL) + truncate to 280 chars |
| `recordRunNotification(input)` | Insert row + publish via event bus |

Best-effort: DB write failure is logged but never blocks the run
lifecycle.

### 4.5 Built-in Dispatch (`dispatch/builtin.ts`, 376 lines)

Assembles `BuiltInAgent` instances for the CopilotKit runtime:

| Function | Purpose |
|---|---|
| `classifyBuiltinPath(pathname)` | Parse URL → `{ agentId, action }` |
| `buildBuiltinAgents(agentIds, log, opts)` | Resolve specs, borrow MCP, compose tools, inject supervisor tools |
| `releaseBuiltinBorrows(borrowed)` | Return MCP connections to pool |
| `recordCapabilityDegradations(runId, degradations)` | Log when MCP/skill failed but agent runs without them |

For each agent ID:
1. `agentPool.get(id)` → `AgentSpec` (cached, decrypted)
2. For each `mcp_server` tool ref: `mcpProviderPool.borrow(serverId)`
3. For each `skill` tool ref: `skillPool.get(skillId)` → inject tools
4. If `role === "supervisor"`: inject supervisor tools (delegate, schedule, etc.)
5. `resolveModel(spec)` → CopilotKit model config
6. Return `BuiltInAgent` with composed system prompt

### 4.6 Supervisor Tools (`supervisor-tools.server.ts`, 719 lines)

Six tools injected when `role === "supervisor"`:

| Tool | Mode | Description |
|---|---|---|
| `delegate_to_agent` | sync | Route to specialist, await result, report back |
| `delegate_async` | async | Fire-and-forget, notify on completion |
| `switch_agent_with_context` | handoff | Transfer conversation to specialist |
| `create_schedule` | — | Create recurring/one-shot schedule |
| `list_schedules` | — | List user's schedules |
| `update_schedule` / `delete_schedule` | — | Modify/remove schedules |

`delegate_to_agent` calls `runner.start()` internally, creating a
child `entity_run` linked via `parentRunId`. The result summary feeds
back into the supervisor's conversation.

### 4.7 Scheduler (`scheduler.ts`, 403 lines)

In-process `setTimeout`-based scheduler (NOT cron):

| Function | Purpose |
|---|---|
| `bootstrapScheduler()` | On boot: load all enabled schedules, arm timers |
| `armSchedule(row)` | Set `setTimeout` for next fire, chain to next |
| `disarmSchedule(id)` | Clear timer |
| `nextFireAt(row)` | Compute next fire from trigger spec |

Trigger spec: `(startAt, [intervalValue, intervalUnit], [endAt])`.
Each fire dispatches through `runner.start({ mode: "async",
initiator: "schedule" })`.

### 4.8 Recovery (`recovery.ts`, 94 lines)

Boot-time sweep for zombie runs left in `running` state by a
prior process crash:

```
recoverStrandedRuns(bootStartedAt)
  → SELECT WHERE status = 'running' AND started_at < bootStartedAt
  → UPDATE SET status = 'failed'
  → recordRunNotification for each
```

Boot-epoch anchored: only flips runs from *prior* processes.
Current-process long-running tasks (>1h) are NOT affected.

### 4.9 Process Boot (`process-boot.ts`, 68 lines)

Inserts one `process_boot` row per Node.js start. The `startedAt`
timestamp is used by `recovery.ts` to identify zombie runs.

---

## 5. Data Model

### entity_run

| Column | Type | Purpose |
|---|---|---|
| `id` | uuid | Primary key |
| `parent_run_id` | uuid | Tree linkage (max depth 3) |
| `thread_id` | text | CopilotKit thread ID |
| `initiator` | enum | `user` / `orchestrator` / `schedule` / `system` |
| `entity_id` | text | Agent/team/workflow ID |
| `entity_kind` | enum | `agent` / `team` / `workflow` |
| `entity_source` | enum | `backend` / `builtin` |
| `credential_id` | uuid | Backend credential (null for builtin) |
| `mode` | enum | `sync` / `async` / `scheduled` |
| `status` | enum | `queued` / `running` / `awaiting_input` / `paused` / `succeeded` / `failed` / `cancelled` |
| `input_task` | text | User's prompt (truncated to 1000 chars) |
| `output_summary` | text | Agent's response summary |
| `error_message` | text | Error description if failed |
| `owner_id` | uuid | User who initiated |
| `started_at` | timestamp | Run start time |
| `finished_at` | timestamp | Run end time |

### entity_run_event

| Column | Type | Purpose |
|---|---|---|
| `run_id` | uuid | FK to entity_run |
| `seq` | integer | Monotonic sequence within run |
| `type` | text | One of `EntityRunEventType` — see `docs/runner-events.md` §8.1 (11 values: lifecycle + AG-UI-sourced + `degraded` + 3× `workflow_node_*`) |
| `payload` | jsonb | Event-specific data |
| `ts` | timestamp | Event timestamp |

---

## 6. Request Flow — Complete Example

### User sends a chat message to a built-in agent:

```
Browser → POST /api/copilotkit/builtin/agent/nango-supervisor/run
  │
  ├─ Route handler: withSession → requireSession
  ├─ runner.runBuiltinChatRequest(request, { userId, requestId, log })
  │
  ├─ 1. classifyBuiltinPath("/api/copilotkit/builtin/agent/nango-supervisor/run")
  │     → { agentId: "nango-supervisor", action: "run" }
  │
  ├─ 2. isAgentVisibleTo("nango-supervisor", userId) → true
  │
  ├─ 3. buildBuiltinAgents(["nango-supervisor"], log, { userId, mode: "auto" })
  │     ├─ agentPool.get("nango-supervisor") → AgentSpec
  │     ├─ mcpProviderPool.borrow(mcpServerId) × N
  │     ├─ skillPool.get(skillId) × N
  │     ├─ role === "supervisor" → inject delegate_to_agent, create_schedule, ...
  │     ├─ resolveModel(spec) → { model: "gpt-4o", ... }
  │     └─ return { agents, borrowed, degradations }
  │
  ├─ 4. extractRunInput(request) → { task: "Analyze sales data", threadId: "t-123" }
  │
  ├─ 5. recordRunStart({ entityId: "nango-supervisor", initiator: "user", ... })
  │     → entity_run row (status: "running")
  │
  ├─ 6. PersistingAgent wraps each agent
  │     → events tee'd to entity_run_event as they stream
  │
  ├─ 7. CopilotSseRuntime({ agents }) → handler
  │     → handler(request) → SSE Response streaming AG-UI events
  │
  ├─ 8. Agent calls delegate_to_agent("data-analyst", "Run SQL on sales")
  │     ├─ runner.start({ entityId: "data-analyst", parentRunId: run.id, mode: "sync" })
  │     ├─ recordRunStart (child, depth=2) → entity_run row
  │     ├─ agent.run() → collect events → summary
  │     ├─ finalizeRun(childRunId, "succeeded")
  │     └─ return summary → supervisor incorporates into response
  │
  ├─ 9. PersistingAgent receives RUN_FINISHED
  │     → finalizeRun(parentRunId, "succeeded")
  │     → recordEvent("finished", { summary })
  │
  └─ 10. finally: releaseBuiltinBorrows + flushLangfuse
```

### Workflow refresh dispatch (W2 + D4a)

`POST /api/artifacts/[id]/refresh` is the third caller of
`runner.start()` (besides supervisor tools and the scheduler):

```
Browser → POST /api/artifacts/[id]/refresh
  │
  ├─ refreshArtifact / buildArtifactBundle({ forceFresh: true })
  ├─ executeWorkflow(...) — src/lib/artifacts/execute-workflow.ts
  ├─ workflow-run-recorder.startRecording(...)
  │     → entity_run row (entityKind: "workflow", entitySource:
  │       "builtin", initiator: "user", mode: "sync", parentRunId: null)
  ├─ engine.execute({ runId, ... }) with buildRealRunAgent(ownerId)
  │     │
  │     for each agent node:
  │     ├─ runner.start({
  │     │     entityId: node.agentId,   // builtin agent UUID
  │     │     parentRunId: workflowRunId,
  │     │     mode: "sync",
  │     │     initiator: "user",
  │     │     ownerId,
  │     │   })
  │     │   → child entity_run row, depth=2
  │     └─ awaits result.outputSummary as `{ text: summary }`
  │
  └─ recorder.succeed() → workflow entity_run = succeeded
```

The runner is invoked **only** from the `forceFresh: true` (refresh)
path. The artifact GET path uses `stubRunAgent` and never dispatches
agents — see `docs/workflow.md` §5.

---

## 7. File Layout

```
src/lib/runner/
├── runner.ts                   843 lines  Execution kernel (RunnerImpl)
├── types.ts                    113 lines  Runner interface + types
├── index.ts                      8 lines  Public export (singleton)
├── persisting-agent.ts         321 lines  AG-UI event → DB decorator
├── dispatch/
│   └── builtin.ts              376 lines  Built-in agent assembly
├── supervisor-tools.server.ts  719 lines  6 supervisor-only tools
├── scheduler.ts                403 lines  setTimeout-based scheduler
├── event-store.ts              161 lines  entity_run + event CRUD
├── event-bus.ts                 77 lines  In-process pub/sub
├── notifications.ts            110 lines  Notification authoring
├── recovery.ts                  94 lines  Boot-time zombie sweep
├── process-boot.ts              68 lines  Boot record
├── schedule-dto.ts              61 lines  DTO transformation
├── schedule-mutate.ts          137 lines  Schedule CRUD
└── schedule-validation.ts       90 lines  Trigger spec validation
```

---

## 8. Key Design Decisions

### 8.1 Recursion Depth Limit (3)

Supervisor → specialist → sub-specialist chains are capped at depth 3.
Beyond this, `RecursionDepthExceeded` is thrown. This prevents
delegation loops and keeps the entity_run tree browsable.

### 8.2 Idempotent Finalization

`finalizeRun` only writes when `status = 'running'`. This means:
- A late error handler can't overwrite a status the PersistingAgent
  already recorded
- Double-finalize is safe (no-op)

### 8.3 Boot-Epoch Recovery

Recovery does NOT use "stuck for >1 hour" heuristics. It uses the
boot timestamp: any run with `started_at < boot.startedAt` is by
definition from a prior process and gets flipped to `failed`. This
avoids false-positiving on legitimately long-running current tasks.

### 8.4 Capability Degradation

When an MCP server, skill, or supervisor runtime fails to load during
`buildBuiltinAgents`, the agent still runs — just without that
capability. The degradation is logged and written as a `degraded`
event on the run (payload `{ ref, refName, reason, message }` —
see `docs/runner-events.md` §4.2 / §9). This ensures a flaky MCP
server or a backend catalog outage doesn't block the entire chat.

Degradable capabilities: `mcp_server`, `model`, `spec`, `supervisor`.

### 8.5 Bookkeeping Bypass

CopilotKit's `/info` and `/threads/*` endpoints are NOT real runs.
`isRunRequest()` filters these out so they skip the `entity_run`
lifecycle entirely. Errors on bookkeeping paths are logged with
structured context (credentialId, entityId) but not recorded as runs.

### 8.6 Sync Run Timeout

`startSync` (used by `delegate_to_agent`) races the agent stream
against a configurable timeout (`runner.sync_timeout`, default 300s).
On timeout the run is finalized as failed and the timer is cleaned up.
The agent stream may continue in the background but its result is
discarded.

### 8.7 Scheduler Graceful Shutdown

`shutdownScheduler()` clears all armed timers and resets the
bootstrapped flag. Called on `SIGTERM` / `SIGINT` via handlers
registered in `instrumentation.ts` so `setTimeout` callbacks don't
prevent the process from exiting.

### 8.8 IANA Timezone Validation

`isValidTimezone(tz)` validates against `Intl.supportedValuesOf("timeZone")`
before any schedule is persisted. Invalid timezone strings are rejected
by `validateTriggerSpec` at all entry points (REST API, supervisor
tools, schedule-mutate).

### 8.9 Trigger Error Isolation

`triggerSchedule` separates the `runner.start()` try-catch from the
DB bookkeeping update. If the run succeeds but the DB update fails,
the schedule is NOT incorrectly marked as failed — a log.error is
emitted for the bookkeeping failure while the run itself is preserved.

---

## 9. Test Coverage

| File | Test File | Coverage |
|---|---|---|
| event-bus.ts | event-bus.test.ts | Fully covered (7 tests) |
| schedule-dto.ts | schedule-dto.test.ts | Fully covered (5 tests) |
| schedule-validation.ts | schedule-validation.test.ts | Fully covered (19 tests) |
| notifications.ts | notifications.test.ts | previewBody covered (5 tests) |
| event-store.ts | event-store.test.ts | RecursionDepthExceeded covered (2 tests) |
| recovery.ts | recovery.test.ts | Core flow covered (2 tests) |
| process-boot.ts | process-boot.test.ts | Core flow covered (2 tests) |
| scheduler.ts (pure fns) | schedule-validation.test.ts | isValidTimezone + validateTriggerSpec timezone (9 tests) |
| runner.ts | — | No unit tests (integration layer) |
| persisting-agent.ts | — | No unit tests (needs AG-UI mock) |
| dispatch/builtin.ts | — | No unit tests (needs pool mocks) |
| supervisor-tools.server.ts | — | No unit tests (needs runner mock) |
| scheduler.ts (timer paths) | — | No unit tests (needs timer mock) |

The untested files are deeply coupled integration layers. Testing them
requires mocking CopilotKit Runtime, AG-UI event streams, and multiple
pool interactions. They are better covered by integration tests with
a real (or mock) LLM endpoint.
