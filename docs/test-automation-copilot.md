# Test Automation Copilot & Closed-Loop QA Architecture

Status: Active Specification · Target Subsystems: Verification (P1), Evaluation (P2), Web Auto (P3) · Last Updated: 2026-09-02

---

## 1. Product Positioning & Core Philosophy

Nango currently supports **Single-Form Shared State & Co-Editing** (`propose_page_edit` via `docs/shared-state.md`), which allows the Copilot agent to stage non-destructive field-level edits into the currently open editor form.

**Test Automation Copilot** extends this capability from single-field editing into a **dedicated `role: 'tester'` AI agent** orchestrating the **full-lifecycle, closed-loop QA workflow** across three test harnesses:
1. **Verification Subsystem (`docs/verification.md`)**: Deterministic MCP Tool & Workflow testing.
2. **Evaluation Subsystem (`docs/evaluation.md`)**: Stochastic LLM-as-Judge conversational agent evaluation.
3. **Web Auto Subsystem (`docs/web-auto.md`)**: Playwright-based browser end-to-end automation.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Closed-Loop Tester Agent Lifecycle                                │
│                                                                                                  │
│  [1. WYSIWYG Page Ctx] ──► [2. Schema Synthesis] ──► [3. Matrix Planning] ──► [4. Batch Creation]│
│     (Slim Index + Focus)      (get_*_schema/spec)        (Happy / Bound / Neg)   (create_test_cases)│
│                                                                                       │          │
│                                                                                       ▼          │
│  [8. HTML Report / Outcome] ◄── [7. Smart Repair] ◄── [6. Run RCA] ◄── [5. Auto Execution]       │
│     (generate_html_page)        (update_test_case)    (get_run_details)  (run_test_suite)        │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Core Tenets & Differentiations

| Dimension | Form Copilot Edit (`propose_page_edit`) | Test Automation Copilot (`role: 'tester'`) |
| :--- | :--- | :--- |
| **Agent Persona** | General Built-in / Supervisor Agent | **Dedicated `role: 'tester'` QA Expert Agent** |
| **Tool Mounting** | Manual user binding or frontend tool | **Automatic Kernel Mounting** (zero configuration, zero tool pollution) |
| **Ambient Context Model** | Heavy full-suite serialization | **WYSIWYG Slim Index + Active Focus** (`{ suite, cases: [index], selectedCase: [full], outcome: [current] }`) |
| **Outcome Semantic** | N/A | **Strict WYSIWYG**: Reflects whatever is actively rendered on screen (live Playground run or user-selected historical run) |
| **Deep Dive Model** | Passive / all-in-memory | **Index First ➔ Drill-down on Demand** (via `get_test_case_detail`) |
| **Operation Target** | Single active form field | Multi-case CRUD + Suite Execution + RCA Diagnostics + HTML Reports |
| **Persistence Model** | Staged in React memory (Save Button) | Direct DB transaction with safe write barrier (`enabled = false`) |
| **SWR Cache Sync** | Client state mutates locally | Server tool completion triggers SWR `mutate()` on left panel |

---

## 2. Dedicated Tester Agent Role & Automatic Tool Mounting

### 2.1 Role Schema Definition (`builtin_agent.role`)

In `src/lib/db/schema.ts`, the `AgentRole` union is extended to include `"tester"`:

```typescript
export type AgentRole = "supervisor" | "secretary" | "evaluator" | "tester";
```

### 2.2 Kernel Auto-Mounting Contract

When an agent with `role === "tester"` is dispatched in `src/lib/runner/dispatch/builtin.ts`:
- All testing tools (CRUD, Execution, Diagnostics) are **automatically constructed and mounted** into the agent's tool execution scope.
- Normal assistant / supervisor agents receive **zero testing tools**, eliminating prompt context pollution and tool hallucinations.
- Normal agents with `sharedStateEnabled: true` still have access to the ambient WYSIWYG page context to answer queries and propose form edits, but cannot execute raw DB mutation tools.
- `userId` is captured via closure at factory build time for multi-tenant RBAC enforcement.

```
BuiltinAgent.role === "tester"
  │
  ├── 1. Asset & Case Management (CRUD)
  │     ├── get_test_case_detail({ kind, caseId })
  │     ├── create_test_cases({ kind, suiteId?, cases: [...] })
  │     ├── update_test_case({ kind, caseId, patch: {...} })
  │     └── delete_test_cases({ kind, caseIds: [...] })
  │
  ├── 2. Suite & Case Execution
  │     ├── run_test_suite({ kind, suiteId })
  │     └── run_test_case({ kind, caseId })
  │
  ├── 3. Diagnostics & Root Cause Analysis (RCA)
  │     ├── get_test_run_details({ kind, runId, failedOnly?, caseId? })
  │     ├── get_mcp_tool_schema({ serverId, toolName? })
  │     └── get_target_agent_spec({ agentId })
  │
  └── 4. Deliverables & Reporting
        ├── generate_html_page (ECharts visual test report)
        └── save_outcome (Workspace Asset archival)
```

---

## 3. Standardized WYSIWYG Page Context Specification

### 3.1 Design Philosophy: "What You See Is What The Agent Gets"

To perfectly balance **Token Efficiency**, **In-Memory Draft Awareness**, and **Cross-Agent Compatibility**, the page context adheres to two foundational rules:

1. **Macro Sibling Cases as Slim Index**: The suite's 30+ sibling test cases are published only as a lightweight sitemap index (`{ id, name, enabled }`), capping ambient token usage at ~80 tokens.
2. **Micro Active Case as Full In-Memory Detail**: The single currently selected test case (`selectedCase`) provides full un-saved draft scripts, input parameters, assertions, and dirty state.
3. **Outcome Strict WYSIWYG Synchronization**: The `outcome` field strictly mirrors what is **currently visible on the user's screen**:
   - If viewing a live Playground execution ➔ `outcome` carries the live in-memory result (`source: "live"`).
   - If the user clicked a historical run in the recent runs banner ➔ `outcome` carries that exact user-selected historical execution snapshot (`source: "history", historySeq: N`).
   - If no run has occurred or been selected ➔ `outcome: null`.
   - Agents **never** guess or asynchronously fetch unrelated background runs without user instruction.

### 3.2 Canonical Context Schema

```typescript
export interface TestModulePageContext {
  /** Subsystem identifier */
  kind: "verification" | "evaluation" | "web_auto";

  /** Suite Metadata */
  suite: {
    id: string;
    name: string;
    description?: string | null;
    caseCount: number;
    target?: {
      mcpServerId?: string;
      serverName?: string;
      targetAgentId?: string;
      agentName?: string;
    };
  };

  /** Lightweight Sibling Case Index (Sitemap) */
  cases: Array<{
    id: number;
    name: string;
    enabled: boolean;
  }>;

  /** Active Focused Case (Full In-Memory Detail & Unsaved Drafts) */
  selectedCase: {
    id: number;
    name: string;
    enabled: boolean;
    isDirty: boolean;
    /** Raw input parameters, script body, or conversation turns */
    input: Record<string, unknown>;
    /** Full universal assertions array */
    assertions: unknown[];
  } | null;

  /** Strictly WYSIWYG Current Displayed Outcome */
  outcome: {
    source: "live" | "history";
    historySeq?: number;
    status: "passed" | "failed" | "running";
    error?: unknown;
    verdict?: unknown;
    /** Trimmed execution output (sanitized to prevent massive Base64 token waste) */
    output?: unknown;
  } | null;
}
```

**Token Footprint**: ~400–600 tokens total (down from 30K+), achieving a 98% reduction while maintaining 100% active state fidelity.

---

## 4. Universal Tester Tool Specifications

### 4.1 Case Management Tools (CRUD)

#### 1. `get_test_case_detail`
- **Parameters**: `kind: "verification" | "evaluation" | "web_auto"`, `caseId: number`.
- **Returns**: Full persisted `{ id, suiteId, name, input, assertions, enabled, createdAt, updatedAt }`.

#### 2. `create_test_cases`
- **Parameters**:
  - `kind: "verification" | "evaluation" | "web_auto"`
  - `suiteId?: string` (UUID, optional — triggers Lazy Suite creation if omitted)
  - `targetContext?: { mcpServerId?: string, targetAgentId?: string }`
  - `cases: Array<CaseCreatePayload>` (Max 20 per call)
- **Write Barrier**: All created cases default to **`enabled = false`** and `createdBy = ctx.userId`.
- **De-duplication**: Cases matching existing names in the target suite are skipped and reported in `{ skipped: [...] }`.

#### 3. `update_test_case`
- **Parameters**:
  - `kind: "verification" | "evaluation" | "web_auto"`
  - `caseId: number`
  - `patch: { name?, input?, assertions?, enabled? }`
- **Returns**: `{ ok: true, caseId, modifiedFields: string[] }`.

#### 4. `delete_test_cases`
- **Parameters**:
  - `kind: "verification" | "evaluation" | "web_auto"`
  - `caseIds: number[]` (Max 20 per call)
- **Returns**: `{ ok: true, deletedCount: number }`.

---

### 4.2 Execution & Diagnostic Tools

#### 1. `run_test_suite` & `run_test_case`
- **`run_test_suite({ kind, suiteId })`**: Dispatches an async suite run on the runner, returns `{ runId, status: "dispatched" }`.
- **`run_test_case({ kind, caseId })`**: Runs an in-memory Playground execution (zero DB writes), returns immediate `runOutcome`.

#### 2. `get_test_run_details`
- **Parameters**:
  - `kind: "verification" | "evaluation" | "web_auto"`
  - `runId: string`
  - `failedOnly?: boolean` (Default: `true`)
  - `caseId?: number` (Optional single-case deep dive)
- **Summary-First Protection**:
  - Summarizes overall pass/fail stats and lists failing cases with 1:1 `assertionResults` diffs.
  - Automatically truncates large execution outputs / base64 images unless `caseId` is explicitly targeted.

---

### 4.3 Deliverables & Reporting Tools

#### 1. `generate_html_page` (Interactive Report)
- Generates a standalone HTML dashboard including:
  - Pass/Fail Pie Chart & Latency Histograms (via CDN ECharts).
  - Categorized failure triage list (Bug vs Assertion Drift vs Flake).
  - Expandable assertion diffs.

#### 2. `save_outcome` (Workspace Asset Archival)
- Saves the generated test report directly into the user's Workspace Outcome registry for historical auditing.

---

## 5. Subsystem Case Schemas

### 5.1 Verification (`kind: "verification"`)
- `input`: `Record<string, unknown>` (MCP tool arguments).
- `assertions`: `assertionsArraySchema` supporting `js_expression`, `jsonpath`, `json_schema`.

### 5.2 Evaluation (`kind: "evaluation"`)
- `input`: `{ turns: Array<{ userMessage: string }> }`.
- `assertions`: `assertionsArraySchema` supporting:
  - `llm_judge`: with `expectation`, `unexpectation`, or `reference`.
  - `tool_call`: expected tool name & argument matches.
  - `metric`: `duration_s` (seconds, 1 decimal place), `output_tokens`, `total_tool_calls`.

### 5.3 Web Auto (`kind: "web_auto"`)
- `input`: `{ script: string, steps?: string }` (Playwright script body).
- `assertions`: `assertionsArraySchema` supporting `js_expression`, `jsonpath`, `json_schema`, and `llm_judge`.

---

## 6. SWR Real-Time Mutation Protocol

To ensure immediate frontend UI reflection when the Tester Agent performs DB operations:

```typescript
// Client-side observation in ChatProviderHooks
// When a tester tool returns { ok: true, suiteId }, mutate corresponding SWR cache:
const isTestingTool = (toolName: string) =>
  ["create_test_cases", "update_test_case", "delete_test_cases"].includes(toolName);

if (isTestingTool(result.toolName) && result.suiteId) {
  mutate(`/api/${result.kind}-suites/${result.suiteId}/cases`);
}
```

---

## 7. Implementation Roadmap

| Phase | Milestone | Deliverables |
| :--- | :--- | :--- |
| **Phase 1 (P1)** | **`role: 'tester'` & WYSIWYG Context Alignment** | 1. Extend `AgentRole` to include `"tester"` in `src/lib/db/schema.ts`.<br>2. Extend `BuiltinAgentEditor` to support Tester role selection.<br>3. Implement kernel auto-mounting in `runner/dispatch/builtin.ts`.<br>4. Align Slim WYSIWYG Context across `VerificationSuiteEditor`, `EvaluationSuiteEditor`, `WebAutoEditor`. |
| **Phase 2 (P2)** | **Universal Tester Tools Implementation** | 1. Implement `src/lib/authoring/` tool modules (CRUD, Execution, Diagnostics).<br>2. Implement SWR auto-mutation hooks.<br>3. Factory unit tests covering RBAC, write barriers, and de-duplication. |
| **Phase 3 (P3)** | **Tester Agent Prompting & Reporting** | 1. QA Expert system prompt block configuration.<br>2. HTML Test Report generator with ECharts.<br>3. End-to-end integration tests across Verification, Evaluation, and Web Auto. |
