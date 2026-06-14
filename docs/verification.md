# Verification Subsystem

> **Status (V1)**
> - **MCP tool tests** — shipped end-to-end. Schema, runner, SSE
>   pipeline, suite/case CRUD, single-case rerun, suite run with
>   live updates, history-view via the recent-runs banner, and the
>   `(input snapshot, output, assertion verdicts, error envelope)`
>   inspector are all in place. Everything in §2–§8 (excluding the
>   workflow callouts) describes the current implementation.
> - **Workflow tests** — schema-level only. The left-panel tab
>   lists workflow suites; the editor renders a "coming soon"
>   placeholder. No runner, no case CRUD, no API. Tracked in §5.3,
>   §7.1, §8.5, and §11.
>
> **Position in the product**: a *deterministic* assert-on-output
> harness. Stochastic / quality-grade evaluation of agents lives in
> the separate **Eval** subsystem (`docs/eval.md`, TBD).

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
| `verification_suite` | Groups cases. | `id`, `name`, `category` (mcp/workflow), `timeout_sec` |
| `verification_case` | An individual test case. | `id`, `suite_id`, `mcp_server_id`, `tool_name`, `workflow_id`, `input`, `assertions` |
| `verification_run` | A suite execution. | `id`, `suite_id`, `status`, counts (`passed`, `failed`, etc.) |
| `verification_case_result`| Outcome of a case. | `id`, `verification_run_id`, `verification_case_id`, `status`, `input_snapshot`, `result_payload`, `assertion_results`, `error` |

*Note: `verification_case` enforces XOR between (mcp_server_id + tool_name) and workflow_id.*

#### Why MCP cases do **not** write `entity_run`

`entity_run` represents "an agent / team / workflow was dispatched"
(`AGENTS.md` §11). An MCP tool call is not an entity dispatch — it is
a single function invocation against `mcp/provider-pool`. Threading
tool calls through the runner would inflate the kernel's contract,
add zombie-sweep concerns to a synchronous code path, and provide no
extra forensics value (the result is already in
`verification_case_result.result_payload`). Workflow cases go through the
runner because Nango internal workflows already do.

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
| `jsonpath_equals` | Deep equality check on a JSONPath. | `path: "items[0].id", expected: "abc"` |
| `js_expression` | Executes a pure JS expression in a restricted `node:vm`. | `result.totalCount > 42` |

- Empty assertions array acts as a smoke test (passes if no upstream error).
- Assertions can target the raw MCP envelope by prefixing paths with `$` or using the `envelope` JS binding.

## 5. Execution

- **Single-case run**: Synchronous. Updates UI state but does NOT write to the database.
- **Suite run**: Asynchronous, serial. Creates `verification_run` and `verification_case_result` rows. Publishes SSE updates. Tolerant to individual case failures.
- **Real-Time Updates (SSE)**: Publishes `run_started`, `case_finished`, and `run_finished` over the existing `/api/runs/stream` event bus. The client hook `useVerificationRunStream` drives the UI.

## 7. API Routes

All routes are wrapped by `withEditor(routePath, handler)` from
`src/lib/http/route-handlers.ts`.

| Method & Path                                       | Purpose |
|-----------------------------------------------------|---------|
| `GET    /api/verification-suites?category=mcp\|workflow`    | List suites filtered by category. |
| `POST   /api/verification-suites`                           | Create a suite. |
| `GET    /api/verification-suites/[id]`                      | Suite metadata + case summary. |
| `PATCH  /api/verification-suites/[id]`                      | Update name / description / enabled / visibility / `timeout_sec`. |
| `DELETE /api/verification-suites/[id]`                      | Cascade-delete cases + runs + results. |
| `GET    /api/verification-suites/[id]/cases`                | List cases (alphabetical). |
| `POST   /api/verification-suites/[id]/cases`                | Create a case. `CHECK` enforced server-side. |
| `PATCH  /api/verification-cases/[id]`                       | Update name / input / assertions / enabled. |
| `DELETE /api/verification-cases/[id]`                       | Delete a case. |
| `POST   /api/verification-cases/[id]/run`                   | **Synchronous** single-case run; does not persist. |
| `POST   /api/verification-runs`                             | Body `{ suiteId }` → start async suite run; returns `{ runId }`. |
| `GET    /api/verification-suites/[id]/runs?offset=0&limit=5`| Paginated history for the banner. Returns `{ rows: VerificationRunEntity[], total: number }` — `total` drives both absolute chip numbering (`#N`) and a precise "more older runs?" guard for the pagination buttons. |
| `GET    /api/verification-runs/[id]`                        | Run header + all `verification_case_result` rows. Returns `{ run, results }`. Used by `useRunSnapshot` for both the just-completed-run inspector view AND history-view chip selection. |

### 7.1 V1 stubs (workflow)

The workflow CRUD routes are not registered in V1 — attempting to
create a case in a `category='workflow'` suite returns
`501 Not Implemented` with `code: "WORKFLOW_TESTS_V2"`.

---

## 8. UI

The UI is built around `/verification/[id]`, consisting of a left CaseTree column and a right CaseInspector column (2x2 grid: Input, Assertions, Output, Verdicts).

- **CaseTree**: Displays suites and nested cases. Includes statuses driven by live SSE updates or snapshot loads.
- **Recent Runs Banner**: A horizontal list of recent suite runs (`#N · ✓4 ✗2`), allowing pagination. Clicking a run switches the editor into read-only snapshot mode (history-view).
- **Editor panes**: 
  - `INPUT` and `ASSERTIONS` use a debounce/PATCH hook (`useJsonDraft`) for auto-saving.
  - In history-view, `INPUT`, `OUTPUT`, and `VERDICTS` show the frozen snapshot, while `ASSERTIONS` are intentionally not snapshotted (showing a notice instead).
- **Cross-page entry**: From the MCP test page, users can click "Save as case" to persist a successful tool call into a verification case.

## 9. Permissions

| Action | Required role |
|---|---|
| List / view suites, cases, runs, results | `editor`+ |
| Create / edit / delete suites, cases | `editor`+ |
| Run case (sync) or suite (async) | `editor`+ |
| Schedule a suite (V2, via `schedule` row with `entity_kind='verification_suite'`) | `editor`+ |

The Verification page is wired to the `editor` group on the LeftToolbar.
`source='builtin'` is not relevant here — verification suites are always
user-authored.

---

## 10. Operational Notes

- **Payload truncation**: `result_payload` is capped at 8 KB. Assertions evaluate on the full payload before truncation.
- **Concurrency**: MCP cases reuse clients from `mcp/provider-pool`.
- **Schema drift**: Assertions are editable after runs; history-view strictly shows the historical `assertion_results` verdicts, not the latest definitions.

## 11. Future Roadmap

- **Workflow verification cases**: Stubbed today; will reuse `runner.start` to test full workflows.
- **Shareable history-view URLs**: Promote UI state to `?run=<id>`.
- **AI-assisted case generation**: Supervisor tool to bulk-author test cases.
- **Schedule-driven regression**: Hook suites into the scheduler.
- **Result blob storage**: Offload >8 KB payloads if needed.

