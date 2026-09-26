# Architecture Improvements Plan

> Status: **In Progress**
> - **Shipped (Foundation)**: P0 (Tool Pipeline), P1 (Safety Guardrails, Tool Risk Registry, Admin Control Plane UI, Input/Output Safety Middlewares), Minimal RunAdmission, and high-severity security bug fixes (BUG-1, BUG-3, BUG-4, BUG-8, BUG-9, BUG-10, BUG-11, BUG-12, BUG-13).
> - **In Progress / Partial**: N1-C (Workflow tool catalog pipeline wrapping), N1-D (Full RunAdmission & Audit integrity).
> - **Pending / Queued**: P2 (Concurrency & recovery), P3 (Prompt engineering), P4 (MCP pool), P5 (Memory), P6 (Cost & observability), P7 (Workflow DAG enhancements), P8 (Supervisor orchestration), and deferred P1 bugs (BUG-2, BUG-5, BUG-6, BUG-14).
> Last audited against codebase: 2026-09-26.

---

## 1. Project Positioning & Constraints

- **Single-node multi-tenant**: No message queues, no multi-replica horizontal autoscaling. Designed for personal and small-team deployments (<20 concurrent users).
- **Work delegation**: Heavy and long-running execution is delegated outward to backend platforms (agno / Mastra / Dify). Built-in agent runtime acts as lightweight orchestration and glue.
- **Security model**: Strict server-side credential isolation. Capabilities available to consumers are strictly bounded by explicit bindings configured by editors/admins.

---

## 2. Priority & Implementation Status

| Priority | Area | Status | Core Deliverables |
|:---|:---|:---:|:---|
| **P0** | Agent Middleware Pipeline | **Shipped (Tool) / Partial (Workflow)** | `src/lib/agent-pipeline/`: Tool pipeline, error handling, approval, sanitization, loop detection. |
| **P1** | Safety Guardrails | **Shipped (Core) / Partial (Tails)** | `src/lib/agent-pipeline/risk-registry.ts`, `/admin/guardrails`, DB policies, input/output safety. |
| **P2** | Task Persistence & Concurrency | **Pending** | Concurrency limits (`runner.max_concurrent`), restart recovery, schedule overlap protection. |
| **P3** | Prompt Engineering | **Pending** | Layered prompt architecture (`stable → context → volatile`), block registry, Secretary role. |
| **P4** | MCP Tool Pool Improvements | **Pending** | Lazy connection, periodic schema discovery, connection cooldowns. |
| **P5** | Memory System | **Pending** | Long-term memory, `pgvector` semantic retrieval, context compression (`docs/memory.md`). |
| **P6** | Observability & Audit | **Pending** | `entity_run.token_usage` JSONB, cost tracking dashboard (`/admin/costs`), audit event integrity. |
| **P7** | Workflow Engine Enhancement | **Pending** | `workflow_revision` table, Predicate AST `Transform` node, conditional branching. |
| **P8** | Supervisor Orchestration | **Pending** | Task progress tools, structured context passing, batch fan-out, Task Plan module. |

---

## 3. Known Bugs & Architectural Gaps Audit

| ID | Sev | Problem Summary | Status | Implementation Details / Files |
|:---|:---:|:---|:---:|:---|
| **BUG-8** | **P0** | `EChartsRenderer` executed LLM-generated `formatter` strings via `new Function` (arbitrary JS in page origin). | **DONE** | `new Function` removed. Safe sanitization via `sanitizeChartOption` in `src/components/workspace/EChartsRenderer.tsx`. (Sandboxed iframe deferred as defense-in-depth). |
| **BUG-9** | **P0** | SQL write detection checked `sqlArgs.sql` instead of `sql_text`, causing auto-approval bypass. | **DONE** | Resolved structurally via `assessArgs` in `src/lib/agent-pipeline/risk-registry.ts`. |
| **BUG-10**| **P0** | `run_skill_script` could run arbitrary host code in unisolated environments. | **DONE** | Mitigated by fail-closed sandbox enforcement (BUG-11). Host subprocess execution disabled by default. |
| **BUG-11**| **P0** | Default sandbox fallback used unisolated `subprocess`, executing code on the host. | **DONE** | Fail-closed in `src/lib/sandbox/registry.server.ts`: requires external sandbox service (`dify-sandbox`); throws `BackendUnavailableError` if unreachable. |
| **BUG-1** | **P1** | `extract_dataset_by_sql` resolved data sources by global name without verifying agent/workflow bindings. | **PARTIAL** | **Done (Execution)**: `buildExtractDatasetTool(allowedDataSourceIds)` in `src/lib/data-sources/runtime-tools.ts` enforces allowed ID set.<br>**Pending (Save-time)**: Owner-scoped resolution in workflow canonicalization. |
| **BUG-3** | **P1** | Evaluation run route bypassed visibility checks applied on list routes. | **DONE** | Enforces `isAgentVisibleTo` and owner filtering in `src/app/api/eval-agents/[id]/run/route.ts` and `src/lib/evaluation/storage.ts`. |
| **BUG-4** | **P1** | `runner.start()` trusted caller-supplied ownership and credentials without admission validation. | **PARTIAL** | **Done (Minimal)**: `admitRun()` in `src/lib/runner/admission.ts` validates entity visibility, credential status, and parent-run ownership.<br>**Pending**: Full structural binding cross-checks. |
| **BUG-12**| **P1** | `readEvents()` did not guarantee chronological order. | **DONE** | Added `.orderBy(asc(EntityRunEventTable.seq))` in `src/lib/runner/event-store.ts`. |
| **BUG-13**| **P1** | `getTaskProgress()` allowed unauthorized progress access across users by `runId`. | **DONE** | Added `userId` and `isAdmin` authorization filters in `src/lib/runner/active-tasks.ts`. |
| **BUG-2** | **P1** | Parquet cache keyed only by name (`datasetDir(name)`), risking cross-editor dataset collisions. | **PENDING** | Keying physical cache by `dataSourceId + queryHash` with opaque handle resolution in `src/lib/data-sources/cache.ts`. |
| **BUG-5** | **P1** | `loadArtifact()` ignores `visibility`, querying only `createdBy = ownerId`, breaking artifact sharing. | **PENDING** | Update query in `src/lib/artifacts/get-artifact.ts` to respect `visibility = 'shared'` (read-only snapshot for non-owners). |
| **BUG-6** | **P1** | `artifact.workflowId` FK is `CASCADE` instead of `SET NULL`, deleting artifacts on workflow deletion. | **PENDING** | Change foreign key in `src/lib/db/schema.ts` to `onDelete: "set null"`. |
| **BUG-14**| **P1** | `entity_run.credentialId` FK is `CASCADE` instead of `SET NULL`, destroying historical audit runs. | **PENDING** | Change foreign key in `src/lib/db/schema.ts` to `onDelete: "set null"`. |
| **BUG-7** | **P1** | Imprecise documentation on credential confinement. | **DONE** | Clarified: Decrypted secrets reside solely in server memory and are never exposed to browser, prompts, or model context. |

---

## 4. Authorization Model & Invariants

Nango implements a team-shared workbench authorization model:

- **Roles & Boundaries**:
  - `Admin`: Full access to all resources; bypasses visibility restrictions.
  - `Editor`: Manages resources (Agents, Workflows, MCP, Skills, Data Sources); resources support `public` or `private` visibility.
  - `User (Consumer)`: Interacts with public agents and own artifacts/dashboards. Cannot access direct builder APIs.
- **Binding as Authorization**:
  - Direct builder access checks `resource visible = public | owned | admin`.
  - Execution authorization checks that the entity is accessible to caller **and** all used resources are explicitly bound to that entity. Bound private resources of a public agent are valid internal dependencies and do not require direct visibility from consumers.
- **Security Invariants (Non-Bypassable)**:
  - Docker/service sandbox isolation (fail-closed).
  - AES-256-GCM credential isolation (server-memory only).
  - RunAdmission entry gate.
  - SQL AST parse (read-only SELECT enforcement).
  - SSH regex command allow/deny policies.

---

## 5. P0 / P1 — Implemented Foundation: Middleware Pipeline & Safety Guardrails

### 5.1 Architecture

The pipeline standardizes tool execution interception across execution paths:

```
[Tool Call]
   │
   ▼
SafetyPolicyMiddleware (order 30) ──► Input pattern block/warn
   │
   ▼
ToolApprovalMiddleware (order 40) ──► Evaluates Tool Risk Registry (HITL / Headless deny)
   │
   ▼
ToolErrorHandlingMiddleware (order 50) ──► Converts exceptions to structured { isError, message }
   │
   ▼
[Tool Execution]
   │
   ▼
ToolResultSanitizationMiddleware (order 55) ──► Strips framework tags from external results
   │
   ▼
LoopDetectionMiddleware (order 60) ──► Detects & breaks consecutive identical calls
   │
   ▼
[Tool Output / Context Wrapping]
```

- **Core modules**: Located in `src/lib/agent-pipeline/`:
  - `compose.ts`: Middleware composition (`composeToolPipeline`).
  - `risk-registry.ts`: Tool risk metadata catalog & MCP hint inference.
  - `sanitizer.ts`: Tag neutralization for external tools.
  - `loop-detection.ts`: Repetitive call circuit breaker.
  - `untrusted-context.ts`: Boundary markers (`<<<UNTRUSTED_SOURCE_DATA>>>`).
  - `input-safety.ts`: User input injection pattern inspection.
  - `output-safety.ts`: Secret and PII redaction on output streams.
  - `guardrail-service.ts`: Effective configuration provider with memory cache.

### 5.2 Safety Guardrail Items Catalog

| # | Item | Layer | Type | Status | Implementation Details |
|:---|:---|:---|:---:|:---:|:---|
| **G1** | RunAdmission | Admission | Invariant | **Shipped (Min)** | `src/lib/runner/admission.ts`: Validates entity visibility, parent-run, credential. |
| **G2** | SQL Policy | Execution | Invariant | **Shipped** | `src/lib/data-sources/`: AST parse (`node-sql-parser`), SELECT-only, table allow/deny. |
| **G3** | SSH Policy | Execution | Invariant | **Shipped** | `src/lib/ssh/`: Regex allow/deny with deny-precedence per host. |
| **G4** | Sandbox Isolation | Execution | Invariant | **Shipped** | `src/lib/sandbox/registry.server.ts`: Fail-closed Docker service (`dify-sandbox`). |
| **G5** | Credential Confinement | Execution | Invariant | **Shipped** | AES-256-GCM encrypted in DB; decrypted only in server process memory. |
| **G6** | Tool Approval (HITL) | Pipeline | Configurable | **Shipped** | `ToolApprovalMiddleware`: Gates on declared tool risk; agent approval modes (`auto/always/never`). |
| **G7** | Tool Risk Registry | Pipeline | Configurable | **Shipped** | `risk-registry.ts`: Declared risk levels, MCP hints inference, fallback to fail-closed approval. |
| **G8** | Tool Error Handling | Pipeline | Invariant | **Shipped** | `ToolErrorHandlingMiddleware`: Wraps throws into `{ isError: true, message }`. |
| **G9** | Result Sanitization | Pipeline | Configurable | **Shipped** | `sanitizer.ts`: Neutralizes framework tags (`<system-reminder>`, etc.) in external outputs. |
| **G10**| Untrusted Context Wrap | Pipeline | Configurable | **Shipped** | `untrusted-context.ts`: Encloses external data in `<<<UNTRUSTED_SOURCE_DATA>>>` blocks. |
| **G11**| Loop Detection | Pipeline | Configurable | **Shipped** | `loop-detection.ts`: Blocks repeated identical tool calls exceeding threshold. |
| **G12**| Token Budget | Run/Pipeline | Configurable | **Pending** | Per-run hard cap terminating execution with `stopReason: "token_capped"`. |
| **G13**| Output Redaction | Output | Configurable | **Shipped** | `output-safety.ts`: Redacts secrets and PII patterns before stream persistence. |
| **G14**| HTML CSP Injection | Output | Invariant | **Pending** | Inject restrictive CSP meta tags into `generate_html_page` outputs. |
| **G15**| Renderer No-Eval | Output | Invariant | **Shipped (Eval)** | ECharts `new Function` removed; iframe sandbox deferred. |
| **G16**| Rate Limiting | Input | Configurable | **Pending** | In-memory token bucket per user and global RPM limits. |
| **G17**| Input Validation | Input | Configurable | **Shipped** | Length checks and basic encoding verification in `input-safety.ts`. |
| **G18**| Prompt Injection Detection | Input | Configurable | **Shipped** | Regex pattern matching via `safety_policy` rules in `input-safety.ts`. |
| **G19**| Inspector Agent | Cross-cut | Configurable | **Pending** | LLM second opinion for ambiguous `action = 'warn'` detections. |
| **G20**| Headless Deny | Pipeline | Configurable | **Shipped** | Immediate denial of approval-required tools when `isHeadless = true`. |
| **G21**| Skill Script Scanner | Execution | Configurable | **Pending** | Static security scanner for imported/external skill scripts prior to execution. |
| **G22**| Prompt Safety Block | Prompt | Soft Guide | **Shipped** | `SAFETY_POLICY_BLOCK` injected into system prompt. |

### 5.3 Admin Control Plane (`/admin/guardrails`)

Available at `src/app/(workspace)/admin/guardrails/page.tsx` (`withAdmin` guard):
1. **Pipeline Visualizer**: 14-node dynamic serpentine view showing real-time enabled state of each security layer.
2. **Tool Risk Overrides**: Row-level risk and approval override table backed by `tool_risk_override` table.
3. **Safety Policies**: Pattern and model evaluation rules backed by `safety_policy` table.
4. **Audit Logs**: Security interception trail streamed from `safety_interception_log`.

---

## 6. Pending Architectural Modules (P2 – P8)

### P2 — Task Persistence & Concurrency `[PENDING]`

1. **Concurrency Limits (`runner.start`)**:
   - `runner.max_concurrent` (global, default 20) and `runner.max_per_user` (per-user, default 5).
   - Internal sub-runs (`parentRunId != null`) are exempt to prevent self-deadlock during agent delegation.
2. **Restart Recovery (`recovery.ts`)**:
   - `queued` runs with `started_at < boot` rescheduled if `retry_count < max_retries`.
   - Add `retry_count` and `last_retry_at` columns to `entity_run`.
3. **Scheduler Overlap Guard**:
   - Skip scheduled dispatch if a running execution exists for the same `schedule_id` (`schedule.skip_if_running = true`).

### P3 — Prompt Engineering Infrastructure `[PENDING]`

1. **Layered Assembly (`stable → context → volatile`)**:
   - **Stable**: Identity, tool rules, error handling (prefix-cached by LLM providers).
   - **Context**: Bound tools, agent catalog, skills (per session).
   - **Volatile**: Current datetime, ephemeral runtime state (per turn).
2. **Block Registry**: Pure function `composePrompt(spec, context)` with snapshot tests replacing string concatenation.
3. **Secretary Role**: Dedicate reserved `secretary` role to lightweight maintenance: title generation, summary, and compression.

### P4 — MCP Tool Pool Improvements `[PENDING]`

1. **Lazy Connection**: Establish MCP connection on first tool invocation rather than agent dispatch.
2. **Schema Change Detection**: Periodic re-discovery of tool definitions with targeted cache invalidation.
3. **Failure Recovery**: Differentiated cooldowns (transient network error vs auth failure) with exponential backoff.

### P5 — Memory System `[PENDING]`

- Implements specifications in `docs/memory.md`:
  - Three-tier memory structure (working, session, long-term).
  - Semantic search via `pgvector`.
  - Write-time security scan and optimistic locking.

### P6 — Observability & Cost Tracking `[PENDING]`

1. **Token Usage Persistence**:
   - Add `token_usage` JSONB column to `entity_run` (`inputTokens`, `outputTokens`, `totalTokens`, `estimatedCostUsd`).
   - Parsed from AG-UI stream by `PersistingAgent`.
2. **Result Metadata**: Add `result_metadata` JSONB (`stopReason`, `toolCallCount`, `durationMs`).
3. **Audit Integrity**: Track `dropped_event_count` on `entity_run` to detect lost timeline events.
4. **Cost Dashboard**: Admin UI at `/admin/costs` aggregating token usage across users, agents, and models.

### P7 — Workflow Engine Enhancement `[PENDING]`

1. **Independent Lifecycle**: Decouple workflow execution from artifacts; allow standalone listing, running, and scheduling.
2. **Workflow Revisions**:
   ```sql
   CREATE TABLE workflow_revision (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workflow_id uuid NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
     revision_number integer NOT NULL,
     canonical_spec jsonb NOT NULL,
     spec_hash text NOT NULL,
     created_by uuid REFERENCES "user"(id),
     created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE(workflow_id, revision_number)
   );
   ```
3. **Transform Node**: Predicate AST supporting filter, sort, limit, and select compiled to DuckDB SQL queries over Parquet datasets.
4. **Conditional Branching**: Per-node `gate` condition evaluating to skipped status when false.

### P8 — Supervisor Orchestration `[PENDING]`

1. **Task Tracking Tools**: Expose `check_task_status({ runId })` and `list_active_tasks({})` to supervisor.
2. **Structured Context**: Pass untrusted reference context between delegated agents in a designated user-role message.
3. **Parallel Async Fan-out**: `delegate_batch_async` tool returning run IDs without holding parent synchronous execution.
4. **Task Plan Module**:
   - Tables: `task_plan` and `task_plan_step`.
   - Supervisor tools: `plan_tasks` and `execute_plan` with user-visible progress.

---

## 7. Updated Roadmap

```
Phase 1: Foundation (COMPLETED)
├── [x] P0 Tool Middleware Pipeline (core scaffolding)
├── [x] P1 Tool Risk Registry & Fail-Closed Defaults
├── [x] P1 Admin Guardrails Control Plane (/admin/guardrails)
├── [x] P1 Middlewares (sanitizer, untrusted context, loop detection, input/output safety)
├── [x] P0/P1 High-Severity Bug Fixes (BUG-8, BUG-9, BUG-10, BUG-11, BUG-1, BUG-3, BUG-4 min, BUG-12, BUG-13)

Phase 2: Remaining Foundation & Hygiene (IN PROGRESS / NEXT)
├── [ ] N1-C: Wrap workflow tool catalog with composeToolPipeline
├── [ ] N1-D: Full RunAdmission (credential structural binding cross-checks)
├── [ ] BUG-5: Artifact visibility = 'shared' query fix
├── [ ] BUG-6: DB FK cascade fix (artifact.workflow_id -> SET NULL)
├── [ ] BUG-14: DB FK cascade fix (entity_run.credential_id -> SET NULL)
├── [ ] BUG-2: Content-addressed dataset cache (dataSourceId + queryHash)
├── [ ] P2: Concurrency limits & restart recovery

Phase 3: Workflows & Supervisor (UPCOMING)
├── [ ] P7: Independent workflow execution & workflow_revision table
├── [ ] P7: Transform node (Predicate AST)
├── [ ] P8: Supervisor task status tools & structured delegation context
├── [ ] P8: Parallel delegation & Task Plan module

Phase 4: Optimization & Advanced Features (LATER)
├── [ ] P3: Layered prompt caching architecture
├── [ ] P4: MCP lazy connection & schema re-discovery
├── [ ] P5: Memory system (pgvector & memory.md implementation)
├── [ ] P6: Token cost dashboard (/admin/costs)
```

---

## 8. Architectural Invariants & Non-Goals

### Invariants (Never Bypassable)
- **Zero Client Credentials**: Decrypted credentials never reach browser, prompts, or model context.
- **Fail-Closed Execution**: Unisolated host code execution is prohibited. Missing dependencies disable capabilities.
- **Binding Authorization**: Execution is strictly bounded by explicit resource bindings on the admitted entity.
- **Audit Immutability**: All dispatches produce an `entity_run` entry with sequential timeline events.

### Non-Goals
- Multi-replica distributed consensus / clustering.
- Cyclic workflows (DAG structure strictly preserved).
- In-process arbitrary VM code execution (`node:vm`).
- Direct database mutation by untrusted clients.
