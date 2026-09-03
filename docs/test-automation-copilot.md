# Test Automation Copilot & Closed-Loop QA Architecture

Status: Active Specification · Target Subsystems: Verification, Evaluation, Web Auto · Last Updated: 2026-09-02

---

## 1. Product Architecture & Philosophy

Nango supports a dual-tier testing automation paradigm:
1. **Form Copilot Ambient Context**: Lightweight WYSIWYG perception for all agents when `sharedStateEnabled: true` is active.
2. **Dedicated Tester Agent (`role: 'tester'`)**: An autonomous Senior Software Development Engineer in Test (SDET) and QA Architect equipped with full-lifecycle server-side tools to discover, generate, execute, diagnose, and remediate test assets across three core subsystems:
   - **Verification Subsystem (`docs/verification.md`)**: Deterministic testing dedicated exclusively to MCP Server tools.
   - **Evaluation Subsystem (`docs/evaluation.md`)**: Stochastic LLM-as-Judge conversational agent evaluation across multi-turn dialogues.
   - **Web Auto Subsystem (`docs/web-auto.md`)**: Playwright-based browser end-to-end automation with dual-tier assertions (JS VM sandbox & LLM evaluation).

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Closed-Loop Tester Agent Lifecycle                                │
│                                                                                                  │
│  [1. Ambient Context] ──► [2. Suite Discovery] ──► [3. Matrix Planning] ──► [4. Batch Creation] │
│     (Slim Index + Focus)     (list_test_suites)       (Equivalence / BVA)    (create_test_cases) │
│                                                                                       │          │
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
- All 10 testing lifecycle tools are **automatically constructed and mounted** into the agent's tool execution scope via `buildTesterTools(ctx)`.
- Standard supervisor / assistant agents receive **zero testing tools**, eliminating tool hallucinations and prompt pollution.
- `userId` and `isAdmin` are strictly captured via **factory function closure** at construction time (`buildTesterTools({ userId: ctx.userId, isAdmin })`), enforcing multi-tenant RBAC without exposing user IDs to model parameters.
- Execution and diagnostic tools (`run_test_case`, `run_test_suite`, `get_test_results`, `list_test_suites`, `get_test_suite_details`, `get_test_case_details`) are registered in `APPROVAL_EXEMPT_TOOLS` to guarantee uninterrupted autonomous test pipelines.
- Tool errors are automatically captured and wrapped into structured failure objects `{ isError: true, message, toolName }` by the kernel middleware pipeline (`wrapTools`), maintaining unbroken chat session streams.

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
      targetAgentId?: string;
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

## 4. Implemented Tester Tool Specifications (10 Tools)

All tools are located under `src/lib/testing/tools/` and accept `category: "verification" | "evaluation" | "web-auto"`.

### 4.1 Discovery & Topology Tools

#### 1. `list_test_suites`
- **Parameters**: `category` (required).
- **Behavior**: Retrieves all accessible suites for the given category with metadata (id, name, description, case counts, enabled counts, target bindings).

#### 2. `get_test_suite_details`
- **Parameters**: `category`, `suiteId` (UUID).
- **Behavior**: Retrieves complete suite configuration along with its lightweight child cases array (`[{ id, name, enabled }]`).

### 4.2 Suite & Case Management Tools (CRUD)

#### 3. `create_test_suite`
- **Parameters**:
  - `category`
  - `name`: string (1–120 chars)
  - `description?`: string
  - `mcpServerId?`: string (required for `verification`)
  - `targetAgentId?`: string (required for `evaluation`)
- **Behavior**: Creates a new test suite. For `web-auto`, automatically detects the active Playwright MCP server without requiring user input. Enforces uniqueness on suite names per user.

#### 4. `get_test_case_details`
- **Parameters**: `category`, `caseId` (integer).
- **Behavior**: Retrieves full persisted case details including input payloads, multi-turn prompts (`turns`), scripts, and parsed assertions array.

#### 5. `create_test_cases`
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
    - `assertions`: Array of assertion specs (`js_expression`, `jsonpath`, `json_schema`, `metric`, `tool_call`, `llm_judge`)
- **Safety Contract (Write Barrier)**: **All newly created cases are hardcoded to `enabled: false`** upon insertion. Requires explicit human review before activation.

#### 6. `update_test_case`
- **Parameters**:
  - `category`, `caseId`
  - Partial fields: `name`, `enabled`, `toolName`, `input`, `turns`, `script`, `steps`, `assertions`.
- **Behavior**: Applies partial patch to the specified case. Used for assertion tuning, prompt refinement, or activating approved cases (`enabled: true`).

#### 7. `delete_test_case`
- **Parameters**: `category`, `caseId`.
- **Behavior**: Permanently deletes the test case and cascades removal of associated execution results. Returns `{ category, deleted: true, caseId, suiteId, caseName }`.

### 4.3 Execution & Diagnostic Tools

#### 8. `run_test_case` (Synchronous Debugging)
- **Parameters**: `category`, `caseId`.
- **Behavior**: Directly executes a single case end-to-end against the target runtime (`runMcpCase`, `runEvalCase`, or `runWebAutoCase`). Returns execution status, duration, detailed assertion evaluation outcomes, score, and error message.

#### 9. `run_test_suite` (Asynchronous Batch Regression)
- **Parameters**: `category`, `suiteId`.
- **Behavior**: Dispatches an asynchronous batch run across all enabled test cases via the subsystem orchestrator (`startSuiteRun`, `startEvalSuiteRun`, `startWebAutoSuiteRun`). Immediately returns `{ runId, status: "running", totalCases }` without blocking the conversation turn.

#### 10. `get_test_results` (Diagnostics & RCA)
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

## 5. Codebase Organization

```
src/lib/testing/
├── index.ts                      # Testing module export barrel
├── prompt.ts                     # DEFAULT_TESTER_SYSTEM_PROMPT
├── types.ts                      # Shared interfaces and Zod schemas
├── tester-tools.server.ts        # buildTesterTools factory
└── tools/
    ├── list-test-suites.ts       # Tool 1: list_test_suites
    ├── get-test-suite-details.ts # Tool 2: get_test_suite_details
    ├── create-test-suite.ts      # Tool 3: create_test_suite
    ├── get-test-case-details.ts  # Tool 4: get_test_case_details
    ├── create-test-cases.ts      # Tool 5: create_test_cases
    ├── update-test-case.ts       # Tool 6: update_test_case
    ├── delete-test-case.ts       # Tool 7: delete_test_case
    ├── run-test-case.ts          # Tool 8: run_test_case
    ├── run-test-suite.ts         # Tool 9: run_test_suite
    └── get-test-results.ts       # Tool 10: get_test_results

tests/unit/lib/testing/
├── list-test-suites.test.ts
├── get-test-suite-details.test.ts
├── create-test-suite.test.ts
├── get-test-case-details.test.ts
├── create-test-cases.test.ts
├── update-test-case.test.ts
├── delete-test-case.test.ts
├── run-test-case.test.ts
├── run-test-suite.test.ts
└── get-test-results.test.ts      # 63 unit tests total (100% passing)
```

---

## 6. Pending Items & Next Steps

The following capabilities are queued for upcoming milestones:

### 6.1 Frontend SWR Real-Time Mutation Protocol
- **Objective**: Ensure immediate UI synchronization on the left-panel case trees and suite lists when the Tester Agent executes mutation tools.
- **Scope**:
  - Wire SWR cache invalidation hooks in the Chat Provider / Copilot response listener.
  - When `create_test_cases`, `create_test_suite`, `update_test_case`, or `delete_test_case` succeeds, trigger SWR `mutate()` on `/api/{category}-suites/{suiteId}/cases` and `/api/{category}-suites`.

### 6.2 Visual Test Reporting Deliverables
- **Objective**: Enable the Tester Agent to generate standalone, interactive deliverables.
- **Scope**:
  - Implement `generate_html_page` (or integrate with existing outcome artifact generators) to produce visual QA dashboards using CDN ECharts (pass/fail distribution, duration distributions, categorization of assertion failures).
  - Enable direct archival to Workspace Assets via `save_outcome`.

### 6.3 End-to-End Multi-Turn Scenario Verification
- **Objective**: Full conversational integration tests covering user-to-agent interactions.
- **Scope**:
  - Verify complete lifecycle prompts: *"Inspect this MCP server, plan 5 boundary test cases, execute them, and report results"*.
  - Validate that human review gating (`enabled: false`) is adhered to in conversational flows.
