# Verification Subsystem

> **Status**
> - **MCP tool tests** — shipped end-to-end. Schema, runner, SSE
>   pipeline, suite/case CRUD, single-case rerun, suite run with
>   live updates, history-view via the recent-runs banner, and the
>   `(input snapshot, output, assertion verdicts, error envelope)`
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
   any REST APIs we wrap via MCPHub, behave as the LLM-facing schema
   promises. The MCP tool layer is the one the agent actually sees;
   testing at this layer catches MCPHub conversion errors that a raw
   REST test (Postman) cannot.
2. **Repeatable case organisation** — group cases into suites, share
   them, schedule recurring regression runs.
3. **Failure forensics** — surface *which layer* failed (MCPHub vs
   upstream vs assertion) so a red light is actionable.

What this is **not**:

- Not an agent quality evaluator. Agent outputs are stochastic and
  belong in the Eval subsystem.
- Not a replacement for unit / e2e tests. This is a runtime harness
  for live tools, not a CI gate.

---

## 2. Data Model

Four new tables. Nothing in the existing schema changes.

### 2.1 Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `verification_suite` | Groups cases. | `id`, `name`, `category` ('mcp'), `mcp_server_id` (FK **SET NULL**), `mcp_server_name` (denormalized display snapshot), `timeout_sec` |
| `verification_case` | An individual test case. | `id`, `suite_id` (FK cascade), `tool_name`, `input`, `assertions` |
| `verification_run` | A suite execution. | `id`, `suite_id` (FK cascade), `mcp_server_id` (FK **SET NULL**), `status`, counts (`passed`, `failed`, etc.) |
| `verification_case_result`| Outcome of a case. | `id`, `verification_run_id`, `verification_case_id`, `status`, `input_snapshot`, `result_payload`, `assertion_results`, `error` |

**MCP server lifecycle (detached suites)**: deleting an MCP server detaches its
suites (`mcp_server_id` → NULL) instead of destroying them — suites, cases, run
history and results are all kept, and the denormalized `mcp_server_name` keeps
the left panel grouping intact. Detached suites stay editable/browsable but are
never runnable: run requests fail with a structured "detached" error at both
the REST and tester-tool layers.

#### Why MCP cases do **not** write `entity_run`

`entity_run` represents "an agent / team / workflow was dispatched"
(`AGENTS.md` §11). An MCP tool call is not an entity dispatch — it is
a single function invocation against `mcp/provider-pool`. Threading
tool calls through the runner would inflate the kernel's contract,
add zombie-sweep concerns to a synchronous code path, and provide no
extra forensics value (the result is already in
`verification_case_result.result_payload`).

---

## 3. Error Source Convention

`verification_case_result.error` is JSON, never a free-form string. Shape:

```json
{
  "source": "mcphub" | "upstream" | "transport" | "assertion" | "timeout" | "internal",
  "message": "...",
  "details": { ... }
}
```

| `source` | When | `details` examples |
|---|---|---|
| `mcphub` | MCPHub itself returned an error (502, 504, or its own error envelope). | `{ httpStatus: 502, mcphubRouteId: "..." }` |
| `upstream` | MCPHub reached the upstream REST API and the upstream returned a non-success. | `{ httpStatus: 401, wwwAuthenticate: "Bearer ..." }` |
| `transport` | Network / connection / DNS — never got a response. | `{ kind: "ECONNREFUSED", target: "mcphub:3000" }` |
| `assertion` | Tool returned successfully but at least one assertion failed. (Distinct from `status='failed'` because the `error` field is optional even when `status='failed'`; populated only when one *individual* assertion needs to surface its mismatch as the top-line error.) | `{ assertionPath: "$.data.id", expected: "abc", actual: "xyz" }` |
| `timeout` | Per-case wall-clock or suite-level timeout. | `{ scope: "case" \| "suite", elapsedMs: 30000 }` |
| `internal` | Unexpected throw inside the verification runner itself. **Always a bug.** | `{ stack: "..." }` |

Distinguishing `mcphub` vs `upstream` requires cooperation from
MCPHub. Today MCPHub does not always forward upstream status codes
verbatim. Until that is fixed, the runner classifies as follows:

- `5xx` from MCPHub with `x-mcphub-source: mcphub` header → `mcphub`
- `5xx` from MCPHub with `x-mcphub-source: upstream` header → `upstream`
- `5xx` without the header → `mcphub` (conservative default — points
  the user at the layer Nango owns)
- `4xx` always → `upstream` (MCPHub itself rarely returns 4xx)

This is intentionally **best-effort in V1**; the alternative is a
per-tool sidecar HTTP probe, which is V2 territory.

---

## 4. Assertion Types

`verification_case.assertions` is a JSON array evaluated against the `structuredContent` of the tool result.

| Type | Description | Example |
|---|---|---|
| `json_schema` | Validates against a JSON Schema (Draft 2020-12). | `{"type": "object", "required": ["id"]}` |
| `jsonpath` | Evaluates a JSONPath query against target operators. | `path: "items[0].id", operator: "==", expected: "abc"` |
| `js_expression` | Executes a pure JS expression in a restricted `node:vm`. | `result.totalCount > 42` |

- Empty assertions array acts as a smoke test (passes if no upstream error).
- Assertions can target the raw MCP output by prefixing paths with `$` or using the `root` JS binding.

## 5. Execution

- **Single-case run**: Synchronous. Updates UI state but does NOT write to the database.
- **Suite run**: Asynchronous, serial. Creates `verification_run` and `verification_case_result` rows. Publishes SSE updates. Tolerant to individual case failures. Gated on suite edit permission, `enabled`, and a live MCP binding.
- **Server-wide run** (`mcpServerId` in `POST /api/verification-runs`): executes all enabled cases under one server, **scoped to the triggerer's visible suites** — foreign private suites never execute, and run results are filtered by the same visibility on read. The boot recovery sweep reads unscoped (system context).
- **Real-Time Updates (SSE)**: Publishes `run_started`, `case_finished`, and `run_finished` over the existing `/api/runs/stream` event bus. The client hook `useVerificationRunStream` drives the UI.

## 6. Serial Execution & Cross-Case Reference Contract

Verification suites execute cases serially in deterministic alphabetical order. To support multi-step workflows (e.g. `login` → `create_project` → `delete_project`), cases can reference outputs from earlier cases in the same suite using Mustache-like template variables: `{{cases.<name_or_prefix>.output.<path>}}`.

### 6.1 Numeric Prefix Convention & Aliasing
- **Alphabetical Execution Order**: Cases within a suite execute in lexicographical order by case name. Prepending a 3-digit prefix with a step of 10 (e.g. `010_login`, `020_get_profile`, `030_cleanup`) establishes predictable execution order.
- **Dual Registration in `suiteContext`**: When a case finishes, the orchestrator registers it in the running suite context under two keys:
  1. Full case name: `suiteContext["010_login"] = caseData`
  2. Prefix alias: if the case name begins with digits `^(\d+)` (e.g. `010`), `suiteContext["010"] = caseData` pointing to the exact same object reference (zero memory copy).
- **Usage**: Downstream cases can use either the concise alias `{{cases.010.output.token}}` or the full name `{{cases.010_login.output.token}}`.
- **Precondition (Alias Uniqueness)**: Numeric prefixes must be unique within a single suite. If multiple cases share the same prefix (e.g. `010_test_a` and `010_test_b`), the later-executed case overwrites the `010` alias pointer in `suiteContext`.

### 6.2 Output Unwrapping Rules (`extractMcpStructuredData`)
The `output` object exposed to downstream cases is unwrapped according to strict MCP protocol semantics:
1. **`structuredContent` Priority**: If the MCP result contains `structuredContent`, it is used directly as the unwrapped `output` object.
2. **`content` JSON Parsing**: If `structuredContent` is not present, the runner inspects `content`. If `content` contains a text item whose text parses as valid JSON (object or array), it is parsed and assigned to `output`.
3. **Fallback to Full Envelope**: If neither condition is met (e.g. plain non-JSON text output, primitive values, or unexpected envelope shapes), the entire raw MCP `CallToolResult` envelope is preserved as `output`.
4. **No `result` Demangling**: Unlike WebAuto/AG-UI envelopes, top-level `result` fields are NOT unwrapped. This guarantees that business data containing a `result` property (e.g. `{ result: 42, data: "..." }`) is preserved verbatim and will not cause data loss.

### 6.3 Assertions View vs. Context View
There is a key semantic difference between how assertions and cross-case references view the output:
- **Assertions View (`evaluateAssertions`)**: Operates on the full tool result payload. JSON Schema, JSONPath, and JS expressions (`node:vm`) inspect the tool output directly (or via `$` / `root` bindings).
- **Context View (`extractMcpStructuredData`)**: Prepares the `output` object for `{{cases...}}` template resolution:
  - For structured responses: `output` is the core business object (e.g. `{{cases.010.output.token}}` or `{{cases.010.output.user.id}}`).
  - For non-structured/raw fallbacks: `output` is the raw MCP envelope. Downstream cases must access fields through the envelope structure: `{{cases.010.output.content[0].text}}`.

### 6.4 Suite Boundary & Isolation Semantics
- **Strict Suite Scoping**: The execution context is strictly isolated to the currently executing suite. Cross-suite references are not supported and will not resolve.
- **Contiguity Guarantee in Server Runs**: When executing all suites under an MCP server, cases are ordered by `(suiteName, suiteId, caseName)`. Even if multiple users define suites with the same name, all cases of a given suite execute contiguously without cross-suite interleaving.
- **Context Reset on Suite Boundary**: Crossing into a new suite immediately clears the context: `suiteContext = {}`. This prevents state leakage or accidental cross-suite variable contamination.
- **Failure Forensics (`unresolvedReferences`)**: Unresolved template placeholders remain as literals in input payloads. If a case execution fails or throws, the runner scans inputs for residual `{{cases...}}` tokens and populates `error.details.unresolvedReferences` (e.g. `["{{cases.010.output.token}}"]`), providing immediate diagnostic visibility.

## 7. API Routes

All routes are wrapped by `withEditor(routePath, handler)` from
`src/lib/http/route-handlers.ts`.

| Method & Path                                       | Purpose |
|-----------------------------------------------------|---------|
| `GET    /api/verification-suites`                           | List visible MCP verification suites. |
| `POST   /api/verification-suites`                           | Create a suite. |
| `GET    /api/verification-suites/[id]`                      | Suite metadata + case summary. |
| `PATCH  /api/verification-suites/[id]`                      | Update name / description / enabled / visibility / `timeout_sec`. |
| `DELETE /api/verification-suites/[id]`                      | Cascade-delete cases + runs + results. |
| `GET    /api/verification-suites/[id]/cases`                | List cases (alphabetical). |
| `POST   /api/verification-suites/[id]/cases`                | Create a case. `CHECK` enforced server-side. |
| `PATCH  /api/verification-cases/[id]`                       | Update name / input / assertions / enabled / `suiteId` (moves validate the target suite: existence + edit permission + same MCP server). |
| `DELETE /api/verification-cases/[id]`                       | Delete a case. |
| `POST   /api/verification-cases/[id]/run`                   | **Synchronous** single-case run; does not persist. |
| `POST   /api/verification-runs`                             | Body `{ suiteId }` → start async suite run; returns `{ runId }`. |
| `GET    /api/verification-suites/[id]/runs?offset=0&limit=5`| Paginated history for the banner. Returns `{ rows: VerificationRunEntity[], total: number }` — `total` drives both absolute chip numbering (`#N`) and a precise "more older runs?" guard for the pagination buttons. |
| `GET    /api/verification-runs/[id]`                        | Run header + all `verification_case_result` rows. Returns `{ run, results, visibleCount }`. Used by `useRunSnapshot` for both the just-completed-run inspector view AND history-view chip selection. Server-wide runs scope `results` to the viewer's visible suites. |
| `GET    /api/verification-servers`                          | List MCP servers that have verification suites (left-panel tree groups), with per-user visibility and suite counts. |
| `DELETE /api/verification-servers/[id]`                     | Bulk cleanup: deletes only the suites the caller may delete (per-suite `canDeleteResource`; admin deletes all). Returns `{ deleted, skipped }`. Non-uuid ids → 404. |
| `GET    /api/verification-servers/[id]/cases`, `.../runs`    | Cross-suite per-server listings for the left panel and the server-run history banner. |

---

## 8. UI

The UI is built around `/verification/[id]`, consisting of three columns: a left CaseTree column, a middle column (Input, Assertions), and a right column (Output, Verdicts).

- **CaseTree**: Displays suites and nested cases. Includes statuses driven by live SSE updates or snapshot loads.
- **Recent Runs Banner**: A horizontal list of recent suite runs (`#N · ✓4 ✗2`), allowing pagination. Clicking a run switches the editor into read-only snapshot mode (history-view).
- **Editor panes**: 
  - `INPUT` and `ASSERTIONS` use a debounce/PATCH hook (`useJsonDraft`) for auto-saving.
  - In history-view, `INPUT`, `OUTPUT`, and `VERDICTS` show the frozen snapshot, while `ASSERTIONS` are intentionally not snapshotted (showing a notice instead).
- **Cross-page entry**: From the MCP test page, users can click "Save as case" to persist a successful tool call into a verification case.

## 9. Permissions

| Action | Required role |
|---|---|
| List / view suites, cases, runs, results | `editor`+ (resource visibility applies) |
| Create / edit suites, cases | `editor`+ (`canEditResource` — public suites are collaboratively editable) |
| Delete a suite | Suite author or admin (`canDeleteResource`) |
| Delete a case | Case author OR suite author OR admin (unified rule across all three test modules) |
| Bulk-delete suites under an MCP server | Per-suite `canDeleteResource` — editors delete only their own suites |
| Run case (sync) or suite (async) | Suite edit permission + `enabled` + live MCP binding |
| Server-wide run | Server visibility (view) — but case selection and results are scoped to the triggerer's visible suites |
| Schedule a suite (V2, via `schedule` row with `entity_kind='verification_suite'`) | `editor`+ |

The Verification page is wired to the `editor` group on the LeftToolbar.
`source='builtin'` is not relevant here — verification suites are always
user-authored.

---

## 10. Operational Notes

- **Payload truncation**: `result_payload` is capped at 32 KB by default (configurable via `verification.payload_max_kb`). Assertions evaluate on the full payload before truncation.
- **Concurrency**: MCP cases reuse clients from `mcp/provider-pool`.
- **Schema drift**: Assertions are editable after runs; history-view strictly shows the historical `assertion_results` verdicts, not the latest definitions.

## 11. Future Roadmap

- **Shareable history-view URLs**: Promote UI state to `?run=<id>`.
- **Schedule-driven regression**: Hook suites into the scheduler.
- ~~**AI-assisted case generation**~~: Shipped — see `docs/test-automation-copilot.md` (Tester agent + ambient context).
- **Result blob storage**: Offload large payloads if needed.

