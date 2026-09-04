# Web Auto Subsystem

> **System Status (V1)**
> - **Playwright MCP Runner** — Shipped. Direct execution of Playwright scripts via `browser_run_code_unsafe` bypassing conversational agent overhead.
> - **Dual-Tier Assertion Engine** — Shipped. Combines deterministic assertions (JS expressions in VM sandbox, JSONPath, JSON Schema) with stochastic LLM Evaluator expectations.
> - **Suite & Case CRUD** — Shipped. PostgreSQL-backed two-level hierarchy (Groups -> Suites -> Cases) with SWR client sync and flat routing `/web-auto/[id]`.
> - **SSE Streaming & Global Active Tasks** — Shipped. Real-time run progress broadcasting over `/api/runs/stream`, live case indicators, and Header Active Task Badge tracking.
> - **Crash Recovery** — Shipped. Automated server boot sweep identifying and recovering stranded runs.
>
> **Position in the product**: A deterministic, repeatable browser automation and regression test harness. Execution is purely deterministic (Playwright scripts), while AI is reserved specifically for subjective visual and semantic inspection (LLM-as-Judge).

This document is the technical architecture specification and operational manual for the Web Auto subsystem.

---

## 1. Architectural Philosophy

Traditional agentic web navigation is prone to non-determinism, hallucinations, and high latency when tasked with automated regression testing. Web Auto separates **Execution** from **Evaluation**:

1. **Deterministic Execution**:
   Test cases are authored as direct Playwright scripts (Node.js/JavaScript). They execute inside an isolated browser automation sandbox via the `browser_run_code_unsafe` tool hosted on Playwright MCP servers. The scripts handle DOM interaction, navigation, data extraction, and visual state capture.
2. **Dual-Tier Evaluation**:
   The execution yields structured results and visual/DOM snapshots which are evaluated through two complementary layers:
   - **Tier 1: Deterministic Assertions**: Evaluated instantaneously in a sandboxed Node VM without model calls (e.g. `result.success === true`, `page.url.includes('/dashboard')`, JSON Schema validation).
   - **Tier 2: LLM Evaluator Assertions**: Natural language expectations (e.g., "Verify that the success toast banner is prominently visible") evaluated by a dedicated Evaluator Agent inspecting the captured DOM and screenshots.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Web Auto Test Execution                      │
└─────────────────────────────────────────────────────────────────┘
                               │
               [ 1. Playwright Script Execution ]
                               ▼
               MCP Server: browser_run_code_unsafe
                               │
                    Structured JSON Output
                               │
          ┌────────────────────┴────────────────────┐
          ▼                                         ▼
[ 2. Deterministic Assertions ]          [ 3. LLM Evaluation ]
 - JS Expression VM Sandbox               - Evaluator Agent Dispatch
 - JSONPath Matchers                      - Screenshot / DOM Inspection
 - JSON Schema Validation                 - submit_evaluation_scores
          │                                         │
          └────────────────────┬────────────────────┘
                               ▼
                   [ 4. Unified Verdict ]
               Passed | Failed | Errored
```

---

## 2. Data Model

Web Auto is backed by 4 domain tables in PostgreSQL (`src/lib/db/schema.ts`):

### 2.1 Database Tables

| Table | Purpose | Primary Key | Key Columns |
|---|---|---|---|
| `web_auto_suite` | Groups test cases and defines runtime configurations. | UUID v4 | `id`, `parent_id` (for groups), `name`, `description`, `variables`, `mcp_server_id`, `evaluator_agent_id`, `timeout_sec`, `visibility`, `created_by` |
| `web_auto_case` | Individual test case definition. | UUID v4 | `id`, `suite_id`, `name`, `description`, `script_content`, `assertions`, `enabled`, `created_by` |
| `web_auto_run` | Suite-level execution batch run record. | UUID v4 | `id`, `suite_id`, `status` (`running`, `passed`, `failed`, `errored`), `passed`, `failed`, `errored`, `started_at`, `finished_at`, `created_by` |
| `web_auto_case_result` | Detailed outcome of an individual case within a run. | BigInt Identity | `id`, `run_id`, `case_id`, `status`, `execution_output`, `verdict`, `error`, `created_at` |

### 2.2 Hierarchical Organization

Suites support a strict **2-level hierarchy**:
- **Top-Level Group / Target** (`parent_id IS NULL`): Acts as a directory/domain container (e.g., "E-Commerce App", "Admin Portal").
- **Test Suite** (`parent_id = <group_id>`): The executable unit bound to a Playwright MCP server and optional Evaluator Agent (e.g., "Checkout Flow", "User Authentication").
- **Test Cases**: The atomic test scripts belonging to a Suite.

---

## 3. Core Engine Components

```
src/lib/web-auto/
├── runner-mcp.ts     # Playwright MCP execution & Markdown output parser
├── assertions.ts     # Deterministic assertion engine & expectation extractor
├── evaluator.ts      # Evaluator Agent integration for natural language checks
├── orchestrator.ts   # Case and Suite execution loops & SSE event emission
├── storage.ts        # Database access and transaction layer
├── recovery.ts       # Server boot crash recovery scanner
└── types.ts          # Core interfaces, verdicts, and SSE frame definitions
```

### 3.1 `runner-mcp.ts` (Playwright MCP Execution Layer)
* **Borrow/Release Lifecycle**: Borrows the Playwright MCP provider from `mcpProviderPool` and guarantees safe return in a `finally` block to prevent connection leaks.
* **Execution**: Invokes `browser_run_code_unsafe` with the Playwright script.
* **Output Normalization (`parsePlaywrightOutput`)**: Parses the MCP result payload. Strips Markdown section envelopes (`### Result`, `### Page`, `### Events`) and code block fences (` ```json `), extracting clean JSON outputs and page metadata (URL, Title, Console).
* **Fault Tolerance**: Never throws. All network, MCP server, tool wrapper, and upstream protocol errors are classified into structured outcomes.

### 3.2 `assertions.ts` (Deterministic Assertion Engine)
* **Context Unpacking**: Unpacks structured outputs (`{ result, page }`) so expressions can access `result`, `page`, and `root`.
* **VM Sandboxing**: Executes `js_expression` assertions inside an isolated Node VM sandbox (`isolated-vm` / Node `vm`), exposing `result`, `$`, `page`, and `input`.
* **Standard Matchers**: Evaluates `jsonpath` and `json_schema` rules.
* **Expectation Extraction**: Filters out `type: "expectation"` and `type: "llm_expectation"` rules for handoff to the evaluation layer.

### 3.3 `evaluator.ts` (LLM-as-Judge Layer)
* **Agent Dispatch**: Programmatically triggers the configured `evaluatorAgentId` via `runner.start({ mode: "sync", initiator: "evaluator" })`.
* **Prompt Assembly**: Generates evaluation prompts including structured output, DOM state, and expectations.
* **Score Extraction**: Reads `submit_evaluation_scores` tool calls from `entity_run_event` to obtain objective scores (`criteria_score >= 60` threshold for pass).

### 3.4 `orchestrator.ts` (Execution Orchestrator)
* **Single Case Dispatch (`runWebAutoCase`)**: Executes MCP -> Deterministic Assertions -> LLM Evaluation -> Formats unified `WebAutoExecutionOutcome`.
* **Suite Batch Dispatch (`startWebAutoSuiteRun`)**: Creates `web_auto_run`, iterates over enabled cases, writes `web_auto_case_result`, tracks wall-clock timeouts, and publishes SSE stream frames (`run_started`, `case_finished`, `run_finished`).
* **Notifications**: Triggers `recordRunNotification` upon suite completion for system-wide bell alerts.

### 3.5 `recovery.ts` (Crash Recovery)
* **Boot Scan (`recoverStrandedWebAutoRuns`)**: Executed on server startup via `src/instrumentation.ts`.
* **Zombie Sweep**: Queries all `web_auto_run` records with `status = 'running'` started prior to the server boot timestamp, transitions them to `errored`, logs diagnostics, and emits recovery notifications.

---

## 4. End-to-End Workflows

### 4.1 Single Case Execution (Interactive Debugging)
1. **User Action**: The user selects a case in `WebAutoEditor` and clicks **Run** in the script editor header.
2. **API Dispatch**: Client posts to `POST /api/web-auto-runs/case` with `{ caseId, suiteId }`.
3. **Execution**: Server executes `runWebAutoCase`:
   - Executes script via MCP Playwright.
   - Evaluates deterministic assertions in the VM sandbox.
   - (Optional) Evaluates expectations if an evaluator agent is configured.
4. **Response & Inspector Display**: Returns `WebAutoExecutionOutcome`.
   - Top-right pane renders raw Execution Output.
   - Bottom-right pane renders Verdicts with exact assertion conditions and actual values.

### 4.2 Full Suite Batch Run (Background & Real-Time Streaming)
1. **Trigger**: User clicks the green **Play** icon next to "New Case" in the Suite cases header, or issues `POST /api/web-auto-runs`.
2. **Initialization**: Server creates `web_auto_run` (`status = 'running'`) and broadcasts `run_started` over EventBus.
3. **Global Header Active Task**:
   - `useNotifications` SSE listener receives `run_started` and adds a `web_auto` task to `useActiveTasksStore`.
   - Global Header renders a `GlobeCheck` badge with `0/N` progress.
4. **Case Execution Loop**:
   - Server runs cases sequentially.
   - Upon each case completion, server writes `web_auto_case_result` and publishes `case_finished` (`status`, `durationMs`).
   - Client `useWebAutoRunStream` updates case list status icons (`CircleCheck`, `CircleX`, `AlertCircle`) and execution duration timers (`1.2s`).
   - Header Active Task badge updates progress counter (`1/N`, `2/N`).
5. **Finalization**:
   - Server marks `web_auto_run` as `passed` / `failed` / `errored` and publishes `run_finished`.
   - Bell notification is recorded (`recordRunNotification`).
   - Header badge transitions to green (`succeeded`) or red (`failed`), displaying final completion status.
   - Client starts a 60-second fade-out timer before removing the completed task badge from the header.

---

## 5. UI Architecture & Navigation

Web Auto adheres to Nango's flat, shareable URL routing paradigm:

### 5.1 Routing Structure
* **List / Root View**: `/web-auto` — Handled by `PanelRedirectPage`, automatically redirecting to the first available suite or rendering empty state.
* **Suite Detail View**: `/web-auto/[id]` — Dynamic route rendering `WebAutoEditor` for suite `[id]`.
* **State Synchronization**: `useCopilotSharedState` automatically parses `/web-auto/[id]` into active resource context for the right-hand Copilot sidebar.

### 5.2 Layout Breakdown (`WebAutoEditor.tsx`)
* **Header Bar**: Displays suite name and back navigation.
* **Left Column (Test Suite Cases List)**:
  * Suite header with case count, **New Case** (`Plus`) button, and **Run Suite** (`Play`) button.
  * Interactive case list with live execution badges, duration timers, edit (`SquarePen`), and delete (`Trash2`) actions.
* **Middle Column (Editor Pane)**:
  * Tabs: Playwright **Script** (Node.js code editor) / **Description**.
  * Top toolbar: Dirty state save indicator and primary **Run** button for the selected case.
  * Bottom half: **Assertions** editor (JSON array of deterministic assertions and expectations).
* **Right Column (Forensics Inspector)**:
  * Top half: **Execution Output** (Clean structured JSON / page metadata).
  * Bottom half: **Verdicts** (Detailed evaluation results showing condition descriptions, actual values, and pass/fail indicators).

---

## 6. Error Precedence & Forensics

Web Auto enforces strict error precedence: Infrastructure and transport failures always supersede pure assertion failures.

```
Severity: ERRORED > FAILED > PASSED
```

| Execution Result | Reported Status | Cause |
|---|---|---|
| MCP transport throw / server offline / timeout | `errored` | Infrastructure / connection error |
| Tool missing (`browser_run_code_unsafe` not on server) | `errored` | Server misconfiguration |
| Case missing script / suite missing MCP | `errored` | Client validation failure |
| Playwright script runtime error (page crash / syntax) | `failed` | Tool-level execution failure (`isError: true`) |
| Deterministic assertion mismatch | `failed` | Test condition failed |
| LLM expectation score `< 60` | `failed` | Visual / semantic criteria failed |
| LLM expectation(s) present but suite binds no Evaluator Agent | `errored` | Configuration error (`error.source = "config"`) — LLM judge half not evaluated |
| Script succeeded & all assertions passed | `passed` | Test passed |

### 6.1 Evaluator-Not-Configured Contract

When a case contains judge-dependent assertions (`llm_judge`, `expectation`,
`llm_expectation`) but its suite does not bind an Evaluator Agent
(`evaluatorAgentId` is null):

- The Playwright script and deterministic assertions **still execute** — an
  existing script is executable work, so script runtime errors surface as real
  `failed` defects and are never masked by the configuration problem.
- Each judge-dependent assertion is stored with `skipped: true`, `ok: false`,
  **no numeric `score`**, and the shared reason `"Evaluator agent is not
  configured; the LLM judge portion of this case was not evaluated."` The UI
  renders these rows amber **"Not evaluated"** and excludes them from failed
  tallies / the failed-only filter.
- Final status: deterministic failure → `failed` (score `0`); deterministic
  pass → `errored` (score `null`, `error.source = "config"` with
  `details.missing = "evaluatorAgentId"`).
- A case with **no script and only** judge-dependent assertions short-circuits
  to `errored` before execution.

**Contract: an `errored` outcome never carries a numeric score (`null`), and
skipped judge rows never carry a score.** A missing evaluator is a
configuration problem — it must never surface as a graded `0` ("the target is
bad") or as a green pass with silently dropped judge rows.

## 7. Pending Features & Future Roadmap

The following capabilities represent planned features and ongoing extensions:

### 7.1 Suite-Level Variables Resolution & UI Configuration
* **Script Template Interpolation**: Interpolate suite-level `variables` (e.g. `{{baseUrl}}`, `{{username}}`, `{{password}}`) and generator tokens (`{{$uuid}}`, `{{$timestamp}}`, `{{$randomString}}`) into `scriptContent` prior to MCP execution.
* **Assertion Sandbox Binding**: Expose `variables` (as `input`) in the VM sandbox for `js_expression` assertions (e.g. `result.url === input.baseUrl + '/dashboard'`).
* **Variables Editor in Suite Dialog**: Enhance `NewWebAutoSuiteDialog.tsx` with a dedicated Variables JSON editor to manage suite-level constants and parameters.
* **Suite Settings Header Entry**: Provide a direct settings icon in `WebAutoEditor` header for quick inspection and updates of suite parameters, variables, and MCP bindings.

### 7.2 Visual Steps Table (v2 UX Polish)
* Replace the raw JSON Execution Output pane with an interactive **Steps Table**.
* Parse Playwright execution traces to display individual step names, durations, statuses, and clickable modal popovers for captured screenshots.

### 7.3 Copilot Conversational Script Generator
* Enable the right-side Copilot chatbot to generate complete Playwright test scripts, selector strategies, and assertions from natural language instructions using contextual suite knowledge.