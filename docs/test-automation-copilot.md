# Test Automation Copilot & Closed-Loop QA Architecture

Status: Active Specification · Target Subsystems: Verification, Evaluation, Web Auto · Last Updated: 2026-09-03

---

## 1. Product Architecture & Philosophy

Nango supports a dual-tier testing automation paradigm:
1. **Form Copilot Ambient Context**: Lightweight WYSIWYG perception for all agents when `sharedStateEnabled: true` is active.
2. **Dedicated Tester Agent (`role: 'tester'`)**: An autonomous Senior Software Development Engineer in Test (SDET) and QA Architect equipped with full-lifecycle server-side tools to discover, inspect target/assertion specifications, generate, execute, diagnose, and remediate test assets across three core subsystems:
   - **Verification Subsystem (`docs/verification.md`)**: Deterministic testing dedicated exclusively to MCP Server tools.
   - **Evaluation Subsystem (`docs/evaluation.md`)**: Stochastic LLM-as-Judge conversational agent evaluation across multi-turn dialogues.
   - **Web Auto Subsystem (`docs/web-auto.md`)**: Playwright-based browser end-to-end automation with dual-tier assertions (JS VM sandbox & LLM evaluation).

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Closed-Loop Tester Agent Lifecycle                                │
│                                                                                                  │
│  [1. Ambient Context] ──► [2. Spec Inspection] ──► [3. Matrix Planning] ──► [4. Batch Creation] │
│     (WYSIWYG State)         (get_mcp/agent/         (Equivalence / BVA)      (create_test_cases) │
│                             assertion_schema)                                         │          │
│                                                                                       ▼          │
│  [8. Remediation/Active] ◄── [7. Root-Cause RCA] ◄── [6. Batch Run] ◄── [5. Single Debug]       │
│     (update_test_case)       (get_test_results)     (run_test_suite)      (run_test_case)        │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Dedicated Tester Agent Role & Tool Mounting

### 2.1 Role Schema (`builtin_agent.role`)

The `AgentRole` union includes `"tester"` in `src/lib/db/schema.ts`:

```typescript
export type AgentRole = "supervisor" | "secretary" | "evaluator" | "tester";
```

### 2.2 Kernel Auto-Mounting Contract

When an agent with `spec.role === "tester"` is dispatched in `src/lib/runner/dispatch/builtin.ts`:
- All 13 testing lifecycle tools are **automatically constructed and mounted** into the agent's tool execution scope via `buildTesterTools(ctx)`.
- Standard supervisor / assistant agents receive **zero testing tools**, eliminating tool hallucinations and prompt pollution.
- `userId`, `isAdmin`, and `isEditor` are strictly captured via **factory function closure** at construction time (`buildTesterTools({ userId: ctx.userId, isAdmin, isEditor })`), enforcing multi-tenant RBAC without exposing user IDs to model parameters.
- Execution and diagnostic tools (`run_test_case`, `run_test_suite`, `get_test_results`, `list_test_suites`, `get_test_suite_details`, `get_test_case_details`, `get_mcp_tool_schema`, `get_agent_spec`, `get_assertion_schema`) are registered in `APPROVAL_EXEMPT_TOOLS` to guarantee uninterrupted autonomous test pipelines.
- Tool errors are automatically captured and wrapped into structured failure objects `{ isError: true, message, toolName }` by the kernel middleware pipeline (`defineTool`), maintaining unbroken chat session streams.

### 2.3 System Prompt & Editor Defaults

- **System Prompt**: Built-in default prompt defined in `src/lib/testing/prompt.ts` (`DEFAULT_TESTER_SYSTEM_PROMPT`). It instructs the agent on the three-pillar test pyramid, Equivalence Partitioning (EP), Boundary Value Analysis (BVA), negative testing, structured RCA reports, and strict human review policies.
- **UI Integration**: In `BuiltinAgentEditor.tsx`, selecting the `Tester` role automatically pre-fills:
  - `prompt`: `DEFAULT_TESTER_SYSTEM_PROMPT` (if empty)
  - `name`: `"Tester"` (if empty)
  - `description`: `"Autonomous Software Test Engineer (SDET) responsible for full test lifecycle management."` (if empty)

---

## 3. Standardized Ambient Page Context (WYSIWYG)

When any agent interacts with test suite editors, the ambient page context adheres to strict token efficiency and WYSIWYG synchronization:

```typescript
export interface TestModulePageContext {
  /** Subsystem identifier: 'verification' | 'evaluation' | 'web-auto' */
  kind: "verification" | "evaluation" | "web-auto";

  /** Suite Metadata */
  suite: {
    id: string;
    name: string;
    description?: string | null;
    caseCount: number;
    target?: {
      mcpServerId?: string;
      serverName?: string;
      agentId?: string;
      agentName?: string;
    };
  };

  /** Lightweight Sibling Case Index (~80 tokens) */
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
    input: Record<string, unknown>;
    assertions: unknown[];
  } | null;

  /** Strictly WYSIWYG Current Displayed Outcome */
  outcome: {
    source: "live" | "history";
    historySeq?: number;
    status: "passed" | "failed" | "running";
    error?: unknown;
    verdict?: unknown;
    output?: unknown;
  } | null;
}
```

---

## 4. Implemented Tester Tool Specifications (13 Tools)

All tools are located under `src/lib/testing/tools/` and wrap execution in `defineTool`.

### 4.1 Discovery & Topology Tools

#### 1. `list_test_suites`
- **Parameters**: `category` (required).
- **Behavior**: Retrieves all accessible suites for the given category with metadata (id, name, description, case counts, enabled counts, target bindings).

#### 2. `get_test_suite_details`
- **Parameters**: `category`, `suiteId` (UUID).
- **Behavior**: Retrieves complete suite configuration along with its lightweight child cases array (`[{ id, name, enabled }]`).

### 4.2 Target & Assertion Specification Inspection Tools

#### 3. `get_mcp_tool_schema` (MCP Contract Inspection)
- **Parameters**:
  - `mcpServerId`: UUID (required)
  - `toolName?`: string (optional tool filter)
- **Behavior**: Resolves the target MCP server with visibility access checks. When `toolName` is omitted, returns schemas and descriptions for all registered tools on the server. When `toolName` is specified, returns only that tool's input schema and parameter constraints, maximizing token efficiency.

#### 4. `get_agent_spec` (Agent Behavior Inspection)
- **Parameters**: `agentId`: UUID (required)
- **Behavior**: Retrieves system prompt, language model configuration, bound MCP/database/SSH tools, and attached skills for a target built-in agent. Enforces tenant visibility checks. Essential for designing conversational evaluation test cases without guessing agent capabilities.
- **Security note**: Intentionally returns the **full system prompt** of any agent visible to the caller (including `public` agents) — a deliberate disclosure required for authoring evaluation cases. Treat public agents' system prompts as tenant-readable, and do not store secrets in `builtin_agent.prompt`.

#### 5. `get_assertion_schema` (Universal Assertion Contract Inspection)
- **Parameters**:
  - `category`: `"verification" | "evaluation" | "web-auto"` (required)
  - `assertionType?`: enum (optional type filter)
- **Behavior**: Returns Draft 2020-12 JSON Schema definitions, allowed comparison operators, field validation rules, and working examples. Strictly enforces category capabilities:
  - **`verification`**: Deterministic only (`["jsonpath", "json_schema", "js_expression"]`)
  - **`evaluation`**: Hybrid (`["jsonpath", "js_expression", "llm_judge", "metric", "tool_call"]`)
  - **`web-auto`**: Hybrid (`["js_expression", "jsonpath", "llm_judge"]`)

### 4.3 Suite & Case Management Tools (CRUD)

#### 6. `create_test_suite`
- **Parameters**:
  - `category`
  - `name`: string (1–120 chars)
  - `description?`: string
  - `mcpServerId?`: string (required for `verification`)
  - `agentId?`: string (required for `evaluation`)
- **Behavior**: Creates a new test suite. For `web-auto`, automatically detects the active Playwright MCP server without requiring user input. Enforces uniqueness on suite names per user.

#### 7. `get_test_case_details`
- **Parameters**: `category`, `caseId` (integer).
- **Behavior**: Retrieves full persisted case details including input payloads, multi-turn prompts (`turns`), scripts, and parsed assertions array.

#### 8. `create_test_cases`
- **Parameters**:
  - `category`
  - `suiteId`: UUID
  - `cases`: Array of case payloads (max 20)
    - `name`: string
    - `toolName?`: string (verification)
    - `input?`: JSON object (verification)
    - `turns?`: string[] (evaluation user prompts)
    - `script?`: string (web-auto Playwright code)
    - `steps?`: string (web-auto natural language steps)
    - `assertions`: Array of assertion specs. Supported types are category-scoped: `verification` → `jsonpath`, `json_schema`, `js_expression`; `evaluation` → `jsonpath`, `js_expression`, `llm_judge`, `metric`, `tool_call`; `web-auto` → `js_expression`, `jsonpath`, `llm_judge`. Inspect exact contracts via `get_assertion_schema`.
- **Safety Contract (Write Barrier)**: **All newly created cases are hardcoded to `enabled: false`** upon insertion. Requires explicit human review before activation.

#### 9. `update_test_case`
- **Parameters**:
  - `category`, `caseId`
  - Partial fields: `name`, `enabled`, `toolName`, `input`, `turns`, `script`, `steps`, `assertions`.
- **Behavior**: Applies partial patch to the specified case. Used for assertion tuning, prompt refinement, or activating approved cases (`enabled: true`).

#### 10. `delete_test_case`
- **Parameters**: `category`, `caseId`.
- **Behavior**: Permanently deletes the test case and cascades removal of associated execution results. Returns `{ category, deleted: true, caseId, suiteId, caseName }`.

### 4.4 Execution & Diagnostic Tools

#### 11. `run_test_case` (Synchronous Debugging)
- **Parameters**: `category`, `caseId`.
- **Behavior**: Directly executes a single case end-to-end against the target runtime (`runMcpCase`, `runEvalCase`, or `runWebAutoCase`). Returns execution status, duration, detailed assertion evaluation outcomes, score, and error message.

#### 12. `run_test_suite` (Asynchronous Batch Regression)
- **Parameters**: `category`, `suiteId`.
- **Behavior**: Dispatches an asynchronous batch run across all enabled test cases via the subsystem orchestrator (`startSuiteRun`, `startEvalSuiteRun`, `startWebAutoSuiteRun`). Immediately returns `{ runId, status: "running", totalCases }` without blocking the conversation turn.

#### 13. `get_test_results` (Diagnostics & RCA)
- **Parameters**:
  - `category`
  - `runId?`: UUID (Specific run query mode)
  - `suiteId?`: UUID (Trend comparison query mode)
  - `last?`: integer (1 to 10, default `1`)
  - `failedOnly?`: boolean (default `false`)
- **Behavior**:
  - **Single Run Inspection (`runId` or `last=1`)**: Returns run summary and case-level diagnostic records with formatted assertion diffs.
  - **Historical Comparison (`suiteId` + `last>1`)**: Returns trend metrics across runs (pass rate, scores, duration) for regression evaluation.
  - **`failedOnly=true`**: Filters out passed cases to isolate failing assertions for root cause analysis.

---

## 5. Real-Time Frontend Mutation & Cache Synchronization Protocol

To ensure seamless, zero-polling synchronization between the Tester Agent and the active UI main panels:

```
┌────────────────────────┐      TOOL_CALL_RESULT       ┌───────────────────────────────┐
│ Active Copilot Agent   │ ──────────────────────────► │   useTestMutationSubscriber   │
│ (dispatched mutations) │                             │   (RightPanel event listener) │
└────────────────────────┘                             └───────────────┬───────────────┘
                                                                       │
                                                                       ▼
┌────────────────────────┐         SWR / Store         ┌───────────────────────────────┐
│ Active Main Panels     │ ◄────────────────────────── │  invalidateTestModuleCache    │
│ (CaseTree, SuiteList)  │      mutate() & refresh()   │  (unified cache invalidator)  │
└────────────────────────┘                             └───────────────────────────────┘
```

1. **Protocol-Level Event Listener (`useTestMutationSubscriber`)**:
   - Mounted inside `RightPanel.tsx` (`ChatProviderHooks`).
   - Listens to AG-UI `onToolCallResultEvent` for mutation tools (`create_test_cases`, `create_test_suite`, `update_test_case`, `delete_test_case`).
   - Extracts the result payload and dispatches cache invalidation without manual user page reloads.
2. **Central Invalidation Controller (`invalidateTestModuleCache`)**:
   - Defined in `src/lib/testing/cache-invalidation.client.ts`.
   - Simultaneously triggers SWR cache invalidation (`mutate("/api/{category}-suites")`, `mutate("/api/{category}-suites/{suiteId}")`) and Zustand store bucket refreshes (`caseActions.refresh(suiteId)` / `evalCaseActions.refresh(suiteId)`).

---

## 6. Codebase Organization

```
src/
├── hooks/
│   └── useTestMutationSubscriber.ts      # Protocol-level AG-UI tool-result event subscriber
└── lib/testing/
    ├── index.ts                          # Testing module export barrel
    ├── prompt.ts                         # DEFAULT_TESTER_SYSTEM_PROMPT (13 tools)
    ├── types.ts                          # Shared interfaces, Zod schemas & contracts
    ├── cache-invalidation.client.ts      # Unified SWR & Zustand cache invalidation controller
    ├── tester-tools.server.ts            # buildTesterTools factory (13 tools)
    └── tools/
        ├── list-test-suites.ts           # Tool 1: list_test_suites
        ├── get-test-suite-details.ts     # Tool 2: get_test_suite_details
        ├── get-mcp-tool-schema.ts        # Tool 3: get_mcp_tool_schema
        ├── get-agent-spec.ts             # Tool 4: get_agent_spec
        ├── get-assertion-schema.ts       # Tool 5: get_assertion_schema
        ├── create-test-suite.ts          # Tool 6: create_test_suite
        ├── get-test-case-details.ts      # Tool 7: get_test_case_details
        ├── create-test-cases.ts          # Tool 8: create_test_cases
        ├── update-test-case.ts           # Tool 9: update_test_case
        ├── delete-test-case.ts           # Tool 10: delete_test_case
        ├── run-test-case.ts              # Tool 11: run_test_case
        ├── run-test-suite.ts             # Tool 12: run_test_suite
        └── get-test-results.ts           # Tool 13: get_test_results

tests/unit/
├── hooks/
│   └── useTestMutationSubscriber.test.ts # Subscriber event listener tests
└── lib/testing/
    ├── list-test-suites.test.ts
    ├── get-test-suite-details.test.ts
    ├── get-mcp-tool-schema.test.ts
    ├── get-agent-spec.test.ts
    ├── get-assertion-schema.test.ts
    ├── assertion-validation.test.ts
    ├── create-test-suite.test.ts
    ├── get-test-case-details.test.ts
    ├── create-test-cases.test.ts
    ├── update-test-case.test.ts
    ├── delete-test-case.test.ts
    ├── run-test-case.test.ts
    ├── run-test-suite.test.ts
    ├── get-test-results.test.ts
    └── cache-invalidation.test.ts        # 120 unit tests across 15 test files (100% passing)
```

---

## 7. Pending Items & Next Steps

The following capabilities are queued for upcoming milestones:

### 7.1 Visual Test Reporting Deliverables
- **Objective**: Enable the Tester Agent to generate standalone, interactive deliverables summarizing test campaigns.
- **Scope**:
  - Implement `generate_html_page` (or integrate with existing outcome artifact generators) to produce visual QA dashboards using CDN ECharts (pass/fail distribution, duration histograms, categorization of assertion failure root causes).
  - Enable direct archival to Workspace Assets via `save_outcome`.

### 7.2 Conversational End-to-End Multi-Turn Integration Scenarios
- **Objective**: Full conversational integration tests covering user-to-agent interactions.
- **Scope**:
  - Verify complete lifecycle prompts: *"Inspect this MCP server, plan 5 boundary test cases, execute them, and report results"*.
  - Validate that human review gating (`enabled: false`) is adhered to in conversational flows.

### 7.3 Interactive Batch Execution Live Progress Streaming
- **Objective**: Stream live progress of asynchronous `run_test_suite` executions directly into the chat interface.
- **Scope**:
  - Multiplex SSE run status events into the chat timeline so users can watch batch case progression in real time without navigating away from the chat panel.

### 7.4 One-Click RCA Assertion Auto-Remediation
- **Objective**: Provide automated fix suggestions when test assertions fail due to upstream contract shifts.
- **Scope**:
  - When `get_test_results` detects assertion drift against valid outputs, the Tester Agent can generate a candidate repair diff that users can review and apply with a single confirmation.
