# Safety Guardrails & Agent Middleware Pipeline Subsystem

> **Audience**: Full-stack engineers, AI agent pipeline developers, security architects  
> **See also**: [`docs/architecture.md`](./architecture.md), [`docs/orchestrator.md`](./orchestrator.md), [`docs/architecture-improvements.md`](./architecture-improvements.md)

This document provides the authoritative architectural specification for the **Safety Guardrails & Agent Middleware Pipeline** subsystem in Nango. It describes the interceptor pipeline architecture, tool risk classification registry, configurable safety policies, audit interception logging, process caching, and the administrator control plane.

---

## 1. Overview & Architectural Philosophy

### 1.1 Why an Interceptor Pipeline?
In earlier designs, cross-cutting execution concerns—such as authorization approval, error envelope normalization, retry handling, and data sanitization—were scattered across execution god-functions (`runner/dispatch/builtin.ts`, `PersistingAgent`). Adding a new protection required intrusive edits in core dispatch paths.

The Agent Middleware Pipeline establishes an **ordered, composable interceptor chain** wrapping tool execution:
- **Local enforcement**: Local execution paths (Built-in Agents, Test Verification, Evaluation, and Workflows) strictly enforce the pipeline.
- **Backend observation**: External agent platforms (agno / Mastra / Dify) execute tools upstream; Nango's boundary observes and audits the resulting event stream.

### 1.2 Two-Tier Safety Model
1. **Invariants (Non-Bypassable)**:
   - RunAdmission validation (`admitRun`) at `runner.start`.
   - Sandbox isolation (fail-closed Docker container; no raw host code).
   - SQL policy enforcement (AST parsing via `node-sql-parser`, strict SELECT-only).
   - SSH command regex policy (per-host allow/deny lists with deny precedence).
   - Credential confinement (AES-256-GCM; decrypted strictly within server memory).
   - Renderer safety (no `eval` / `new Function` in client chart renderers).
2. **Configurable Guardrails (Admin-Tunable)**:
   - Tool approval mode (`auto` / `always` / `never`) and row-level risk overrides.
   - External tool result sanitization & untrusted context marker wrapping.
   - Loop detection threshold.
   - Input injection pattern matching & output sensitive data redaction.
   - Headless auto-denial for approval-required tools.

---

## 2. Pipeline Architecture & Execution Flow

```
                      [Tool Call Request]
                               │
                               ▼
               ┌───────────────────────────────┐
               │    SafetyPolicyMiddleware     │  (order: 30)
               │    - Input / Pattern Checks   │
               └───────────────┬───────────────┘
                               │ pass
                               ▼
               ┌───────────────────────────────┐
               │    ToolApprovalMiddleware     │  (order: 40)
               │    - Consults Risk Registry   │
               │    - Checks isHeadless deny   │
               │    - Triggers HITL if needed  │
               └───────────────┬───────────────┘
                               │ pass
                               ▼
               ┌───────────────────────────────┐
               │  ToolErrorHandlingMiddleware  │  (order: 50)
               │  - Traps thrown exceptions    │
               │  - Emits {isError, message}   │
               └───────────────┬───────────────┘
                               │
                               ▼
                    [Tool Execution Target]
               (MCP / Built-in / Skill / Code)
                               │
                               ▼
               ┌───────────────────────────────┐
               │ToolResultSanitizationMiddleware(order: 55)
               │  - Strips framework tags from │
               │    external tool results      │
               └───────────────┬───────────────┘
                               │
                               ▼
               ┌───────────────────────────────┐
               │    LoopDetectionMiddleware    │  (order: 60)
               │  - Detects consecutive calls  │
               │  - Breaks runaway tool loops  │
               └───────────────┬───────────────┘
                               │
                               ▼
               ┌───────────────────────────────┐
               │    UntrustedContextWrap       │
               │  - Wraps data in guard markers│
               │    <<<UNTRUSTED_SOURCE_DATA>>>│
               └───────────────┬───────────────┘
                               │
                               ▼
                   [Output / Message Stream]
```

### 2.1 Middleware Composition Primitive
All middlewares implement the `ToolMiddleware` interface defined in `src/lib/agent-pipeline/types.ts`:

```typescript
export interface ToolMiddleware {
  readonly name: string;
  readonly order: number; // lower order executes earlier (outermost)
  wrapToolCall(
    ctx: MiddlewareContext,
    toolName: string,
    args: Record<string, unknown>,
    next: () => Promise<unknown>,
  ): Promise<unknown>;
}
```

The pipeline is compiled via `composeToolPipeline(middlewares, ctx)` in `src/lib/agent-pipeline/compose.ts`.

---

## 3. Tool Risk Registry (`risk-registry.ts`)

Instead of heuristic name guessing or keyword matching, tools declare static or dynamic risk metadata:

```typescript
export interface ToolRiskMeta {
  riskLevel: "low" | "medium" | "high" | "critical";
  sideEffects: "none" | "read" | "write" | "destructive";
  dataAccess: "none" | "public" | "private" | "secret";
  networkAccess: "none" | "allowlisted" | "unrestricted";
  headlessAllowed?: boolean;
}
```

### 3.1 Decision Principles
- **Fail-Closed Default**: Any tool lacking declared risk metadata defaults to requiring approval (`riskLevel: "high"`, `headlessAllowed: false`).
- **MCP Tool Inference**: When an MCP server provides `readOnlyHint`, `destructiveHint`, or `idempotentHint`, the registry automatically derives low/medium risk. When hints are missing, it defaults to high risk.
- **Dynamic Argument Assessment (`assessArgs`)**: Tools like `run_ssh_command` and `extract_dataset_by_sql` dynamically elevate risk level based on the command content (e.g. read-only `ls` vs destructive `rm`, or `SELECT` vs mutation attempts).
- **Headless Deny**: Automated runs (Cron schedules, background evaluations, async delegations) set `ctx.isHeadless = true`. Approval-required tools are denied immediately without hanging on human input.

---

## 4. Input & Output Content Guardrails

### 4.1 Input Safety (`input-safety.ts`)
- **Injection Pattern Matching**: Regex inspection evaluating input against configured rules in `safety_policy` table.
- **Action Triggers**:
  - `block`: Immediately rejects the request with an explanatory envelope.
  - `warn`: Records a security audit entry and proceeds (or escalates to an inspector role).
  - `log`: Observability record only.

### 4.2 Output Redaction (`output-safety.ts`)
- Scans outbound assistant streaming chunks and persisted timeline records.
- Automatically redacts API keys, secret credentials, and configurable PII regex patterns (`DEFAULT_REDACTION_RULES`).

### 4.3 Indirect Injection Defense
- **Tag Neutralization (`sanitizer.ts`)**: Neutralizes prompt-injection framework tags (e.g. `<system-reminder>`, `<assistant>`) originating from external sources (web fetching, external MCP outputs).
- **Untrusted Context Markers (`untrusted-context.ts`)**: Wraps untrusted external data within boundary markers:
  ```
  <<<UNTRUSTED_SOURCE_DATA>>>
  ... external tool output ...
  <<<END_UNTRUSTED_SOURCE_DATA>>>
  ```
  Coupled with a prompt directive instructing the model to treat content within markers strictly as data, never as instructions.

---

## 5. Control Plane & Data Model

### 5.1 Admin Page (`/admin/guardrails`)
An admin-only single-page workbench (`src/app/(workspace)/admin/guardrails/page.tsx`) providing:
1. **Pipeline Visualizer**: Interactive 14-node serpentine flow depicting the active status of each guardrail layer.
2. **Tool Risk Overrides Table**: Per-tool row-level overrides for `risk_level`, `require_approval`, and `headless_allowed`.
3. **Safety Policies Table**: Regex and AI model evaluation rules.
4. **Interception Audit Logs**: Real-time stream of blocked or warned actions.

### 5.2 Database Tables
- **`tool_risk_override`**: Stores manual admin overrides keyed by `(source, mcp_server_id, tool_name)`.
- **`safety_policy`**: Stores rule definitions (pattern, category, severity, action, scope).
- **`safety_interception_log`**: Append-only security audit log recording intercepted actions, run ID, user ID, and matched policy.

### 5.3 Global In-Memory Cache
- Cached under `globalThis.__nango_guardrail_state` for low-latency lookups.
- Invalidated on write operations via `invalidateGuardrailCache()`.
