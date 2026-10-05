# Verification Subsystem

> **Status**
> - **MCP tool tests** — shipped end-to-end. Schema, runner, SSE
>   pipeline, group/suite/case CRUD, tool prefix engine, dual-snapshot
>   fidelity, single-case debugging run, suite run with live updates,
>   group batch execution with aggregate notifications, history-view via
>   the recent-runs banner, and the `(input snapshot, output, assertion verdicts, error envelope)`
>   inspector are all in place.
> - The verification subsystem is dedicated exclusively to **MCP tool contract verification**.
>
> **Position in the product**: a *deterministic* assert-on-output
> harness for MCP tools. Stochastic / quality-grade evaluation of agents lives in
> the separate **Eval** subsystem (`docs/evaluation.md`).

This document is the single source of truth for the Verification subsystem.
`AGENTS.md` carries the one-paragraph summary + the schema table
reference; everything operational is here.

---

## 1. Why a Verification Subsystem

Three needs the existing surfaces don't cover:

1. **MCP tool contract tests** — verify that our own MCP servers, and
   any REST APIs we wrap via an MCP gateway (e.g. OpenAPI→MCP bridge), behave as the LLM-facing schema
   promises. The MCP tool layer is the one the agent actually sees;
   testing at this layer catches gateway conversion errors that a raw
   REST test (Postman) cannot.
2. **Business-driven repeatable case organisation** — group suites into
   business catalogs (`Group -> Suite -> Case`), decouple test cases from
   raw physical server topologies, share them with team members, and execute
   one-click group regression runs.
3. **Environment drift resilience** — adapt to direct-connect vs. gateway tool
   naming differences via suite-level tool prefix transformation rules (`none/add/remove`),
   retaining 100% case portability.
4. **Failure forensics & audit fidelity** — freeze both `originalToolName` and
   `effectiveToolName` in execution snapshots so historical replays remain
   accurate even after subsequent case edits, surfacing *which layer* failed
   (endpoint vs protocol vs tool vs assertion vs configuration).

What this is **not**:

- Not an agent quality evaluator. Agent outputs are stochastic and
  belong in the Eval subsystem (`docs/evaluation.md`).
- Not a replacement for unit / e2e tests. This is a runtime harness
  for live tools, not a CI gate.

---

## 2. Data Model

The subsystem consists of five core tables (`src/lib/db/schema.ts`):

```mermaid
erDiagram
    verification_group ||--o{ verification_suite : "categorizes (1:N)"
    mcp_server ||--o{ verification_suite : "targets (1:N, ON DELETE SET NULL)"
    verification_suite ||--|{ verification_case : "contains (1:N, CASCADE)"
    verification_suite ||--o{ verification_run : "spawns (1:N, CASCADE)"
    verification_run ||--|{ verification_case_result : "records (1:N, CASCADE)"
    verification_case ||--o{ verification_case_result : "yields (1:N, CASCADE)"

    verification_group {
        uuid id PK "defaultRandom()"
        text name "uniqueIndex lower(name)"
        timestamp created_at "CURRENT_TIMESTAMP"
        timestamp updated_at "CURRENT_TIMESTAMP"
    }

    verification_suite {
        uuid id PK "defaultRandom()"
        uuid group_id FK "references verification_group(id) ON DELETE SET NULL"
        uuid mcp_server_id FK "references mcp_server(id) ON DELETE SET NULL"
        text mcp_server_name "Historical display snapshot"
        jsonb tool_prefix_rule "mode: none|add|remove, prefix: string"
        text name "Suite display name"
        text description "Optional markdown description"
        jsonb variables "Suite literal variables"
        boolean enabled "Active/Inactive flag"
        text visibility "private | public"
        integer case_timeout_sec "Per-case tool execution timeout (default 60s)"
        uuid created_by FK "references user(id), NOT NULL"
        uuid updated_by FK "references user(id), NOT NULL"
        timestamp created_at "CURRENT_TIMESTAMP"
        timestamp updated_at "CURRENT_TIMESTAMP"
    }

    verification_case {
        bigint id PK "generatedAlwaysAsIdentity()"
        uuid suite_id FK "references verification_suite(id) ON DELETE CASCADE"
        text name "Unique per suite"
        text tool_name "Relative tool name (e.g. search_leads)"
        jsonb input "Input argument payload"
        jsonb assertions "Array of assertion specs"
        boolean enabled "Active/Inactive flag"
        uuid created_by FK "references user(id), NOT NULL"
        timestamp created_at "CURRENT_TIMESTAMP"
        timestamp updated_at "CURRENT_TIMESTAMP"
    }

    verification_run {
        uuid id PK "defaultRandom()"
        uuid suite_id FK "references verification_suite(id) ON DELETE CASCADE, NOT NULL"
        text status "running | passed | failed | errored | timeout"
        integer total_count "Total cases planned"
        integer passed_count "Passed cases"
        integer failed_count "Failed cases"
        integer errored_count "Errored cases"
        integer skipped_count "Skipped cases"
        text triggered_by "manual | schedule"
        timestamp started_at "CURRENT_TIMESTAMP"
        timestamp finished_at "Completed timestamp"
    }

    verification_case_result {
        bigint id PK "generatedAlwaysAsIdentity()"
        uuid run_id FK "references verification_run(id) ON DELETE CASCADE"
        bigint case_id FK "references verification_case(id) ON DELETE CASCADE"
        text original_tool_name "Snapshot of case.toolName at run time"
        text effective_tool_name "Real tool dispatched (e.g. gw_search_leads)"
        text status "passed | failed | errored | skipped | timeout"
        jsonb input_snapshot "Frozen input as executed"
        jsonb result_payload "Tool response (truncated if >32KB)"
        boolean result_truncated "Truncation indicator"
        jsonb assertion_results "Per-assertion evaluations"
        jsonb error "Structured error envelope"
        integer duration_ms "Execution latency in ms"
        timestamp started_at "Case start timestamp"
        timestamp finished_at "Case finish timestamp"
    }
```

### 2.1 Table Specifications

| Table | Purpose | Key Constraints & Rules |
|---|---|---|
| `verification_group` | Shared catalog/grouping container. | `name` case-insensitive unique index (`lower(name)`). Shared team directory, auto-hidden when empty. |
| `verification_suite` | The primary Aggregate Root. Binds MCP server, prefix rules, variables, and history. | Unique index on `(name, created_by)`. `groupId` can be `NULL` (Ungrouped). `mcp_server_id` ON DELETE SET NULL. Category and workflow legacy fields eliminated. |
| `verification_case` | An individual test case definition. | `tool_name` stores the relative business tool name. Unique index on `(suite_id, name)`. |
| `verification_run` | Execution instance of a suite. | `suite_id` is NOT NULL (all runs belong to a suite). No server-level run rows. |
| `verification_case_result`| Immutable audit record of a case execution. | Contains both `original_tool_name` and `effective_tool_name` snapshots for 100% audit fidelity. |

### 2.2 MCP Server Lifecycle (Detached Suites & Self-Healing)

When an underlying MCP server is deleted:
1. Foreign key `ON DELETE SET NULL` clears `verification_suite.mcp_server_id`.
2. The denormalized string `mcp_server_name` preserves the historical server name.
3. In the left panel, the suite shows a warning badge and the Run button is disabled (`runDisabled`).
4. In `VerificationSuiteDialog`, an amber warning banner appears: *"Bound MCP Server Deleted. The original server no longer exists. You can re-bind this suite by selecting an available server below."*
5. The user selects any available MCP server and saves to immediately restore full functionality.

### 2.3 Why MCP Cases Do Not Write `entity_run`

`entity_run` represents "an agent / team / workflow was dispatched" (`AGENTS.md` §11). An MCP tool call is a direct function invocation against `mcp/provider-pool`. Threading verification cases through the orchestration kernel would inflate its contract, introduce zombie-sweep concerns to a synchronous code path, and provide no additional forensics value (`verification_case_result` is already self-contained).

---

## 3. Tool Prefix Conversion Engine

MCP gateways or multi-tenant proxies often prepend prefixes (e.g. `crm_`, `gateway_`) to tool names. To allow test cases to be written with pure relative tool names (`search_leads`) and run against both raw servers and gateways without duplication, suites configure a `toolPrefixRule`:

```ts
export type ToolPrefixMode = "none" | "add" | "remove";

export interface ToolPrefixRule {
  mode: ToolPrefixMode;
  prefix: string;
}
```

- **`resolveEffectiveToolName(toolName, rule)`** (`src/lib/verification/tool-name.ts`):
  - `mode: "none"`: returns `toolName` unchanged.
  - `mode: "add"`: prepends `prefix` unless already present (case-insensitive idempotency).
  - `mode: "remove"`: strips `prefix` if present (case-insensitive).
  - Trims whitespace and handles empty/null strings safely.
- **Diagnostics on Missing Tools**:
  If the server returns `-32601 Method not found`, the runner reports structured diagnostic details:
  ```json
  {
    "source": "endpoint",
    "message": "MCP tool \"crm_search_leads\" not found on server \"crm-server\". (Original toolName: \"search_leads\", Mode: \"add\")"
  }
  ```
- **Dual Snapshot Fidelity**:
  `verification_case_result` stores both `original_tool_name` (as configured on the case) and `effective_tool_name` (as sent to MCP). In historical view, the UI displays `originalToolName → effectiveToolName` when transformed.

---

## 4. Error Source Convention

`verification_case_result.error` is JSON, never a free-form string:

```json
{
  "source": "endpoint" | "protocol" | "tool" | "transport" | "assertion" | "timeout" | "config" | "crashed" | "internal",
  "message": "...",
  "details": { ... }
}
```

| `source` | When | `details` examples |
|---|---|---|
| `endpoint` | MCP endpoint returned an HTTP error (4xx/5xx, e.g. 401/403/500/502) or tool not found. | `{ httpStatus: 502 }` / `{ httpStatus: 401 }` |
| `protocol` | Server returned a standard JSON-RPC error object (`raw.jsonRpcError`). | `{ code: -32602, data: { field: "limit" } }` |
| `tool` | Tool execution returned `isError: true` or violated declared `outputSchema`. | `{ message: "Invalid date format" }` |
| `transport` | Network / connection / DNS failure before or during HTTP/SSE session. | `{ kind: "ECONNREFUSED", target: "127.0.0.1:3000" }` |
| `assertion` | Tool returned successfully but assertions failed. | `{ assertionPath: "$.data.id", expected: "abc", actual: "xyz" }` |
| `timeout` | Per-case tool execution timeout reached. | `{ scope: "case", elapsedMs: 60000 }` |
| `config` | Prohibited credential variable, malformed assertion syntax, or missing configuration. | `{ variableKey: "SECRET_KEY" }` |
| `crashed` | MCP server subprocess exited unexpectedly. | `{ exitCode: 1 }` |
| `internal` | Unexpected throw inside runner. Always a bug. | `{ stack: "..." }` |

### 4.1 Three-State Mapping and Negative Testing Contract

1. **Smoke test mode** (empty `assertions` array):
   - Smoke tests verify basic execution capability without custom assertions.
   - If the tool execution succeeds without error, status is `passed`.
   - If the tool returns a `protocol` error (e.g. JSON-RPC `-32602`) or a `tool` error (`isError: true`), status evaluates to `failed` (with `source: "protocol"` or `source: "tool"` recorded in the error envelope).
   - Infrastructure, connection, or process errors (`transport`, `endpoint`, `timeout`, `internal`, `crashed`) evaluate to `errored`.

2. **Assertion-driven testing & Negative tests**:
   - When `assertions` are configured, pass/fail outcome is strictly governed by assertion verdicts.
   - For negative testing (e.g. validating parameter rejection or expected error conditions), authors write explicit assertions targeting `result.jsonRpcError.code == -32602`, `result.jsonRpcError.data.field == "limit"`, or `result.isError == true`.
   - When the expected error assertions match, the case evaluates to `passed`. If assertions do not match, status is `failed` (`source: "assertion"`).
   - Assertion syntax compile errors evaluate to `errored` (`source: "config"`).

---

## 5. Assertion Types

`verification_case.assertions` is a JSON array evaluated against the `structuredContent` of the tool result:

| Type | Description | Example |
|---|---|---|
| `json_schema` | Validates against a JSON Schema (Draft 2020-12). | `{"type": "object", "required": ["id"]}` |
| `jsonpath` | Evaluates a JSONPath query against target operators. | `path: "items[0].id", operator: "==", expected: "abc"` |
| `js_expression` | Executes a pure JS expression in a restricted `node:vm`. | `result.totalCount > 42` |
| `metric` | Asserts on numerical metrics: `duration_s` (execution time) and `output_chars` (payload character length). | `metric: "duration_s", operator: "<", threshold: 5` |

- An empty assertions array acts as a smoke test (passes if no upstream tool error).
- Assertions can target raw MCP output by prefixing paths with `$` or using the `root` JS binding.
- Wildcard array paths (`items[*].field`) evaluate strictly with **"every"** semantics. When paired with `exists` (e.g. `items[*].id exists`), every element in the array must contain the target property. Any unsatisfied items report their 0-indexed positions (e.g. `[1, 2]`).
- **`js_expression` Evaluation Contract**:
  - **VM Context Reuse**: Evaluation initializes a hardened Node `vm` context once per case execution via `vm.createContext` and reuses it across clause probes and value extraction via `runInContext`.
  - **Standard Operand Convention**: The value extractor (`extractJsExpressionActual`) adheres strictly to standard assertion conventions where the Left-Hand Side (LHS) is the dynamic property under test (e.g. `result.count`) and the Right-Hand Side (RHS) is the static threshold/expected literal (e.g. `5`). Inverted forms with literals on the left (e.g. `5 < result.count`) are not supported for value extraction to ensure unambiguous verdict diagnostics.

### 5.1 Save-Time Semantic Validation

Assertions are pre-checked for semantic syntax at save time (`POST /api/verification-cases`, `PATCH /api/verification-cases/[id]`, and Tester Agent tools) via `validateAssertionSyntax`:
- `js_expression`: verified with AST compilation (`new Script('(${expr})')` without execution).
- `json_schema`: compiled with Ajv Draft 2020-12.
- `jsonpath`: parsed with `JSONPath` against structured path selectors and mock filter arrays; regex patterns verified for `matches` operator.
- `metric`: restricted to category metrics (`duration_s`, `output_chars` with `<` or `>`) and finite thresholds.

Any syntax errors trigger an immediate HTTP 400 Bad Request at save time, surfacing instant feedback in the UI editor before test execution.

### 5.2 Universal Assertion Envelope (`AssertionTargetEnvelope`)

The assertion engine (`src/lib/assertions/evaluator.server.ts`) operates on a unified target envelope to eliminate output shape guessing and cross-subsystem drift:

```typescript
export interface AssertionTargetEnvelope {
  target: unknown;       // Default assertion target: inner business payload (e.g. MCP tool structuredContent or script return)
  root?: unknown;        // Complete outer envelope: contains full output, _page metadata, etc.
  page?: Record<string, unknown> | null; // Web page metadata (url, title, console logs) for browser test suites
}
```

**Caller & Scope Binding Contract**:
1. **Direct Unwrapped Target**: Callers (such as Web Auto orchestrator) unwrap script output and pass `{ target, root, page }` explicitly to `evaluateAssertions`.
2. **Backward Compatibility**: `normalizeTargetEnvelope(payload, options)` automatically normalizes legacy `{ result, _page }` structures, `options.root`, and `options.page` without mutating inputs or setting global flags.
3. **JSONPath Addressing**:
   - `target.prop` or `result.prop` (or direct `prop`): evaluates against `target` business data.
   - `page.prop` or `_page.prop`: evaluates against `page` metadata.
   - `root.prop` or `$.prop`: evaluates against the outer envelope `root`.
4. **JS Expression Sandbox**:
   - The VM context exposes `target`, `result` (alias to `target`), `root`, `page`, and `_page`.
   - Host functions and circular handles (e.g. Playwright page handles) are stripped before entering `node:vm` via `sanitizeForSandbox`.

---

## 6. Execution Modes & Orchestration

### 6.1 Execution Modes

- **Single-case debug run** (`POST /api/verification-cases/[id]/run`):
  Synchronous in-memory execution (<50ms). Resolves variables and tool prefixes, returns `{ status, outcome, originalToolName, effectiveToolName }`. Does NOT write database run rows, preventing history pollution.
- **Suite run** (`POST /api/verification-runs` with `{ suiteId }`):
  Asynchronous serial execution. Creates a `verification_run` row and per-case `verification_case_result` rows. Publishes SSE events. Sends a single Notification Bell alert on completion.
- **Group run** (`POST /api/verification-runs` with `{ groupId }`):
  Concurrent multi-suite regression run across all visible enabled suites in the group.
  - **F6 Security Enforcement**: Queries enforce `viewer: VerificationViewer` and apply `visibilitySql`. Private suites of other users are never included.
  - **Aggregate Notification**: Individual suite runs set `suppressNotification: true`. On group completion, an aggregate Notification Bell message is posted (`runId: null`, clicking navigates to `/verification`).

### 6.2 Real-Time Updates (SSE)

Publishes `run_started`, `case_finished`, and `run_finished` events over `/api/runs/stream`. The client hook `useVerificationRunStream` drives real-time UI state updates.

---

## 7. Serial Execution & Cross-Case Reference Contract

Verification suites execute cases serially in deterministic alphabetical order. Downstream cases can reference outputs from earlier cases using `{{cases.<alias_or_name>.output.<path>}}`.

### 7.1 Numeric Prefix Convention & Aliasing
- **Prefix convention**: Case names should use a 3-digit step prefix (e.g. `010_login`, `020_create_order`, `030_cleanup`).
- **Dual registration**: When a case finishes, it is registered under:
  1. Full name: `suiteContext["010_login"] = caseData`
  2. Prefix alias: `suiteContext["010"] = caseData`
- **Usage**: Downstream cases can write `{{cases.010.output.orderId}}`.

### 7.2 Output Unwrapping Rules (`extractMcpStructuredData`)
1. **`structuredContent` priority**: Used directly if present.
2. **`content` JSON parsing**: Text items parsing as valid JSON objects/arrays are unwrapped.
3. **Fallback to full envelope**: Raw `CallToolResult` preserved if non-JSON or primitive.
4. **No `result` demangling**: Top-level `result` fields in business payloads are never stripped.

### 7.3 Suite Variables (Literal Variables)
Defined in `verification_suite.variables`:
- Case input: `{{variables.KEY}}`
- Assertions: `{{variables.KEY}}`
- JS expressions: `variables.KEY` and top-level `KEY`
- **Security constraint (`allowCredentials: false`)**: Credential references are strictly forbidden; any detected credential causes immediate fail-closed error.

---

## 8. UI Architecture & Conventions

### 8.1 Left Panel (`VerificationPanel.tsx`)
- **3-Level Navigation Tree**: `Group -> Suite -> Case`.
- **Group Folders**: Uniform Violet color styling (`text-violet-500/80 dark:text-violet-400/80 transition-colors`) with dynamic `<FolderOpen />` (expanded) and `<Folder />` (collapsed) states for all groups including `Ungrouped`.
- **Group Actions**: One-click Run Group button (`data-action="run-group"`) and Inline Rename (`data-action="rename-group"`).
- **Suite Item Badges**: Displays MCP server name badge (amber border when detached). Automatically suppresses badge if the suite name already contains `(${serverName})`.

### 8.2 Header Breadcrumbs (`VerificationSuiteEditor.tsx`)
- **Format**:
  - Suite root view: `[Highlighted Suite] (Server Group/Server Name)`
  - Selected Case view: `[Highlighted Suite] (Server Group/Server Name) / [Highlighted Case] (Tool Name)`
- **Visual hierarchy**:
  - `suite name` and `case name` are highlighted (`text-sm font-semibold text-foreground`).
  - `(server group/server name)`, `/`, and `(tool_name)` are rendered in muted secondary styling (`text-xs text-muted-foreground font-normal`).
  - Test IDs `verification-suite-heading` and `verification-case-heading` are scoped directly to the entity name elements.

### 8.3 Suite Dialog (`VerificationSuiteDialog.tsx`)
- **Natural field order**:
  1. `Group` (with `+ Create New Group...`)
  2. `Suite Name`
  3. `MCP Server` (with detached re-binding banner)
  4. `MCP Tool Prefix` (`none`, `add`, `remove`)
  5. `Description`
- Sized at `h-[720px] max-h-[92vh]` to prevent vertical scrollbars when expanding new group inputs.

### 8.4 Case Dialog (`NewCaseDialog.tsx`)
- **Field order**: `MCP Server` -> `MCP Tool` -> `Suite Name` -> `Case Name`.

### 8.5 MCP "Save As Case" Integration (`SaveAsCaseDialog.tsx`)
- Capturing a tool call from the MCP management/test page automatically routes to `Ungrouped` -> `Drafts (${serverName})`, computing the next prefix (e.g. `010_toolName`).

---

## 9. API Routes

All handlers use `withEditor` / `withSession` from `src/lib/http/route-handlers.ts`:

| Method & Path | Purpose |
|---|---|
| `GET    /api/verification-groups` | List all active verification groups with suite counts (empty groups hidden). |
| `PATCH  /api/verification-groups/[id]` | Rename a group (transactional reuse if name exists). |
| `GET    /api/verification-suites` | List visible suites with `serverGroup` and `serverName` metadata. |
| `POST   /api/verification-suites` | Create a suite (supports `groupId` or `groupName`, `toolPrefixRule`). |
| `GET    /api/verification-suites/[id]` | Suite metadata + cases summary. |
| `PATCH  /api/verification-suites/[id]` | Update suite (supports re-binding `mcpServerId`, moving groups, changing prefix). |
| `DELETE /api/verification-suites/[id]` | Cascade-delete suite, cases, runs, and results. |
| `GET    /api/verification-suites/[id]/cases` | List cases for suite (alphabetical). |
| `POST   /api/verification-cases` | Create a case (supports explicit `suiteId` or auto-creation into `Drafts (${serverName})`). |
| `PATCH  /api/verification-cases/[id]` | Update case details or move to another suite. |
| `DELETE /api/verification-cases/[id]` | Delete a single case. |
| `POST   /api/verification-cases/[id]/run` | Synchronous single-case debug run (does not persist). |
| `POST   /api/verification-runs` | Start async suite run (`{ suiteId }`) or group run (`{ groupId }`). |
| `GET    /api/verification-runs/[id]` | Full run snapshot (`run`, `results`) for live inspector and history view. |
| `GET    /api/verification-suites/[id]/runs` | Paginated recent runs for suite banner (`offset`, `limit`). |

> *Note: Legacy `/api/verification-servers/*` routes have been completely removed.*

---

## 10. Permissions & Security

| Action | Required Role & Guard |
|---|---|
| View suites, cases, runs, results | `editor`+ (`canEditResource` / visibility checks apply) |
| Create / edit suites, cases | `editor`+ (`canEditResource`) |
| Delete a suite | Suite author or admin (`canDeleteResource`) |
| Delete a case | Case author OR suite author OR admin |
| Single-case debug run | Suite edit permission + `enabled` + live MCP binding |
| Suite run | Suite edit permission + `enabled` + live MCP binding |
| Group run | Enforces `viewer: VerificationViewer` with `visibilitySql` — private suites of other users are sealed from execution |

Verification suites are always user-authored; `source='builtin'` does not apply.
