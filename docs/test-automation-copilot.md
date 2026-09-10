# Test Automation Copilot & Closed-Loop QA Architecture

Status: Active Specification · Target Subsystems: Verification, Evaluation, Web Auto · Last Updated: 2026-09-06

---

## 1. Product Architecture & Philosophy

Nango supports a dual-tier testing automation paradigm:
1. **Form Copilot Ambient Context**: Lightweight WYSIWYG perception for all agents when `sharedStateEnabled: true` is active.
2. **Dedicated Tester Agent (`role: 'tester'`)**: An autonomous Senior SDET / QA Architect equipped with full-lifecycle server-side tools to discover, inspect, generate, execute, diagnose, and remediate test assets across three core subsystems:
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

**Standing boundaries (by design):**
- **Deletion is human-only.** The tester agent has no delete tool; test-case deletion is performed by users in the UI (REST delete follows the unified rule: case author OR suite author OR admin). The `delete_test_case` implementation is kept in `src/lib/testing/tools/delete-test-case.ts` but is not mounted — see `tester-tools.server.ts` for the re-enable point.
- **`update_test_case` may set `enabled: true`** — case activation is allowed through the agent; the "new cases are created disabled" barrier is enforced server-side at creation and reinforced by the system prompt's review workflow.

---

## 2. Dedicated Tester Agent Role & Tool Mounting

### 2.1 Role Schema (`builtin_agent.role`)

```typescript
export type AgentRole = "supervisor" | "secretary" | "evaluator" | "tester";
```

### 2.2 Kernel Auto-Mounting Contract

When an agent with `spec.role === "tester"` is dispatched in `src/lib/runner/dispatch/builtin.ts`:

- **12 testing lifecycle tools** are automatically constructed and mounted via `buildTesterTools(ctx)` (`src/lib/testing/tester-tools.server.ts`). Standard supervisor / assistant agents receive zero testing tools, eliminating tool hallucinations and prompt pollution.
- **Fail-closed mounting gate**: `buildTesterTools` returns `[]` unless `ctx.isEditor || ctx.isAdmin` — defense-in-depth on top of the tester-agent visibility filter and dispatch gating.
- `userId`, `isAdmin`, and `isEditor` are captured via **factory closure** at construction time (`buildTesterTools({ userId, isAdmin, isEditor })`), enforcing multi-tenant RBAC without exposing user IDs to model parameters. All tool queries filter suites by `visibilitySql(ctx, ...)`; run tools additionally enforce the `enabled` flag and (verification) refuse detached suites.
- **Approval exemption**: 9 read/execution tools (`list_test_suites`, `get_test_suite_details`, `get_test_case_details`, `get_test_results`, `run_test_case`, `run_test_suite`, `get_mcp_tool_schema`, `get_agent_spec`, `get_assertion_schema`) are registered in `APPROVAL_EXEMPT_TOOLS` for uninterrupted autonomous pipelines. The write tools (`create_test_suite`, `create_test_cases`, `update_test_case`) are **not** exempt.
- Tool errors are captured and wrapped into structured failure objects `{ isError: true, message, toolName }` by the kernel middleware pipeline (`defineTool`), maintaining unbroken chat session streams.

### 2.3 System Prompt & Editor Defaults

- **System Prompt**: Built-in default defined in `src/lib/testing/prompt.ts` (`DEFAULT_TESTER_SYSTEM_PROMPT`, 12 tools). It instructs the agent on the three-pillar test pyramid, Equivalence Partitioning (EP), Boundary Value Analysis (BVA), negative testing, structured RCA reports, the human-only deletion boundary, and strict human review policies.
- **UI Integration**: In `BuiltinAgentEditor.tsx`, selecting the `Tester` role automatically pre-fills `prompt` (if empty), `name` ("Tester"), and `description` ("Autonomous Software Test Engineer (SDET) responsible for full test lifecycle management.").

---

## 3. Standardized Ambient Page Context (WYSIWYG)

When any agent interacts with test suite editors, the agent receives the currently-open editor state through CopilotKit shared state — assembled **client-side** and pushed on every run.

**Mechanism**:
1. Each editor registers itself through `useCopilotDraft` (`src/hooks/useCopilotDraft.ts`) and reports its data via `getCurrentData()` (150 ms debounced).
2. `useCopilotSharedStateSync` (`src/hooks/useCopilotSharedState.ts`) writes `{activeUrl, activeView, activeResourceId, activeResourceData}` into the agent via `agent.setState(...)`.
3. The CopilotKit runtime serializes `state` into a system message on every run; the tester prompt reads it at `state.context.activeResourceData`.
4. Gating: only `activeResourceData` is gated by `isSharedStateEnabled`; the URL/view/resource-id trio is always pushed. `sharedStateEnabled` defaults to `true` for `supervisor` and `tester` roles.

**De-facto contract of `activeResourceData`** (assembled by each suite editor's `getCurrentData()`; the canonical reference implementations are `VerificationSuiteEditor.tsx`, `EvaluationSuiteEditor.tsx`, `WebAutoEditor.tsx`):

```typescript
{
  suite: {
    id: string;
    name: string;
    description?: string | null;
    caseCount: number;
    target?: {
      mcpServerId?: string;      // verification
      serverName?: string;       // verification display name
      agentId?: string;          // evaluation target
    };
  };
  cases: Array<{ id: number; name: string; enabled: boolean }>;  // ~80 tokens
  selectedCase: {                                                 // full detail incl. unsaved drafts
    id: number;
    name: string;
    enabled: boolean;
    isDirty: boolean;
    input: Record<string, unknown>;
    assertions: unknown[];
  } | null;
  outcome: {                                     // strictly WYSIWYG: what the user sees
    source: "live" | "history";
    historySeq?: number;
    status: "passed" | "failed" | "running";
    error?: unknown;
    verdict?: unknown;
    output?: unknown;
  } | null;
}
```

**Context-first principle (prompt §2)**: the agent answers page questions from `activeResourceData` first and only falls back to server-side tools when information is absent or an action is requested — no re-asking for IDs.

---

## 4. Tester Tool Specifications (12 Mounted Tools)

All tools live under `src/lib/testing/tools/` and are wrapped by `defineTool`. RBAC: suite-scoped `visibilitySql` on every query; write tools additionally require suite-level edit (`canEditResource`); `delete_test_case` is intentionally **not mounted** (see §2.2).

### 4.1 Discovery & Topology

#### 1. `list_test_suites`
- **Parameters**: `category` (required).
- **Behavior**: Retrieves all accessible suites for the category with metadata (id, name, description, case counts, target bindings).

#### 2. `get_test_suite_details`
- **Parameters**: `category`, `suiteId` (UUID).
- **Behavior**: Complete suite configuration plus the lightweight child cases array (`[{ id, name, enabled }]`).

### 4.2 Target & Assertion Specification Inspection

#### 3. `get_mcp_tool_schema`
- **Parameters**: `mcpServerId` (UUID, required); `toolName?` (optional filter).
- **Behavior**: Visibility-checked MCP server contract inspection. Without `toolName`, returns schemas/descriptions for all registered tools; with it, only that tool's input schema.

#### 4. `get_agent_spec`
- **Parameters**: `agentId` (UUID, required).
- **Behavior**: System prompt, model configuration, bound MCP/database/SSH tools, and attached skills of a visible built-in agent — required for authoring evaluation cases.
- **Security note**: Intentionally returns the **full system prompt** of any agent visible to the caller (including `public` agents). Treat public agents' system prompts as tenant-readable; do not store secrets in `builtin_agent.prompt`.

#### 5. `get_assertion_schema`
- **Parameters**: `category` (required); `assertionType?` (optional filter).
- **Behavior**: Draft 2020-12 JSON Schema definitions, allowed operators, validation rules, and working examples per category:
  - **`verification`**: `["jsonpath", "json_schema", "js_expression"]`
  - **`evaluation`**: `["jsonpath", "js_expression", "llm_judge", "metric", "tool_call"]`
  - **`web-auto`**: `["js_expression", "jsonpath", "llm_judge"]`

### 4.3 Suite & Case Management (CRUD)

#### 6. `create_test_suite`
- **Parameters**: `category`; `name` (1–120 chars); `description?`; `mcpServerId?` (required for `verification`); `agentId?` (required for `evaluation`).
- **Behavior**: Creates a suite. For `web-auto`, auto-detects the active Playwright MCP server. Enforces suite-name uniqueness per user.

#### 7. `get_test_case_details`
- **Parameters**: `category`, `caseId` (integer).
- **Behavior**: Full persisted case details — input payloads, multi-turn `turns`, scripts, parsed assertions array.

#### 8. `create_test_cases`
- **Parameters**: `category`; `suiteId`; `cases` (max 20) with `name`, category-specific payload (`toolName`/`input` for verification, `turns` for evaluation, `script`/`steps` for web-auto), and `assertions` (category-scoped — inspect via `get_assertion_schema`).
- **Naming & Ordering Convention (Verification)**: For `verification` suites, cases must be named with a 3-digit prefix and step 10 (e.g. `010_login`, `020_get_profile`) to guarantee deterministic lexicographical execution and enable `{{cases.010.output.xxx}}` alias references.
- **Dynamic Variables & Cross-Case Data**: Inputs support dynamic generator variables (`{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$int(min, max)}}`, `{{$randomString(len)}}`, `{{$counter}}`) and intra-suite cross-case references (`{{cases.<alias>.output.<path>}}`).
- **Safety Contract (Write Barrier)**: all newly created cases are **hardcoded to `enabled: false`** at insertion; explicit human review precedes activation.

#### 9. `update_test_case`
- **Parameters**: `category`, `caseId`, partial `name` / `enabled` / `toolName` / `input` / `turns` / `script` / `steps` / `assertions`.
- **Behavior**: Partial patch for assertion tuning, prompt refinement, or activating approved cases (`enabled: true` — permitted by design; REST routes behave identically).

### 4.4 Execution & Diagnostics

#### 10. `run_test_case`
- **Parameters**: `category`, `caseId`.
- **Behavior**: Synchronous end-to-end execution via `runMcpCase` / `runEvalCase` / `runWebAutoCase`. Returns status, duration, per-assertion outcomes, score, and error. Gates: suite visibility; verification refuses detached suites or missing tool targets; web-auto refuses suites without a Playwright binding.

#### 11. `run_test_suite`
- **Parameters**: `category`, `suiteId`.
- **Behavior**: Asynchronous batch run over all enabled cases via the subsystem orchestrator; immediately returns `{ runId, status: "running", totalCases }`. Gates: suite visibility + `enabled`; verification additionally refuses detached suites; web-auto requires a Playwright binding.

#### 12. `get_test_results`
- **Parameters**: `category`; `runId?` (single-run mode); `suiteId?` + `last` (1–10, trend mode); `failedOnly?`.
- **Behavior**: Single-run inspection with formatted assertion diffs; historical trend comparison (pass rate, scores); `failedOnly` for root-cause isolation. All queries are suite-visibility scoped.

---

## 5. Real-Time Frontend Mutation & Cache Synchronization Protocol

Zero-polling synchronization between the Tester Agent and the active UI panels:

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

1. **`useTestMutationSubscriber`** (`src/hooks/useTestMutationSubscriber.ts`): listens to AG-UI `onToolCallResultEvent` for `create_test_cases`, `create_test_suite`, `update_test_case`, `delete_test_case` (the last entry is retained for future re-enable; the tool is currently not mounted).
2. **`invalidateTestModuleCache`** (`src/lib/testing/cache-invalidation.client.ts`): triggers SWR invalidation (`/api/{category}-suites[...]`) and Zustand store refreshes per category.
3. Known boundary: mutations performed inside supervisor `delegate_to_agent` sub-runs do not stream tool results to the client — see §7 (F13).

---

## 6. Codebase Organization

```
src/
├── hooks/
│   └── useTestMutationSubscriber.ts      # AG-UI tool-result event subscriber
└── lib/testing/
    ├── index.ts                          # Export barrel
    ├── prompt.ts                         # DEFAULT_TESTER_SYSTEM_PROMPT (12 tools)
    ├── types.ts                          # Shared interfaces, Zod schemas & contracts
    ├── cache-invalidation.client.ts      # Unified SWR & Zustand cache invalidator
    ├── tester-tools.server.ts            # buildTesterTools factory (12 mounted; delete disabled)
    └── tools/
        ├── list-test-suites.ts           # list_test_suites
        ├── get-test-suite-details.ts     # get_test_suite_details
        ├── get-mcp-tool-schema.ts        # get_mcp_tool_schema
        ├── get-agent-spec.ts             # get_agent_spec
        ├── get-assertion-schema.ts       # get_assertion_schema
        ├── create-test-suite.ts          # create_test_suite
        ├── get-test-case-details.ts      # get_test_case_details
        ├── create-test-cases.ts          # create_test_cases
        ├── update-test-case.ts           # update_test_case
        ├── delete-test-case.ts           # (not mounted — human-only deletion)
        ├── run-test-case.ts              # run_test_case
        ├── run-test-suite.ts             # run_test_suite
        └── get-test-results.ts           # get_test_results
```

---

## 7. Known Limitations & Improvement Backlog

Current open issues from the consolidated security/architecture review, with recommended approaches. Standing decisions are already reflected in §1–§4 (deletion UI-only; `enabled: true` permitted; risk registration deferred).

| ID | Issue | Current State | Recommended Approach |
|---|---|---|---|
| F10 | Run tools are approval-exempt with no cost quotas; tester tools not registered in `BUILTIN_TOOL_RISK_MAP` | Deferred by decision | Register all 12 tools (mutations with `headlessAllowed: false` so unattended runs cannot write); add per-user/suite run quotas |
| F11 | Access layer triplicated (verification/eval `access.ts`, web-auto inline checks) | Delete rules unified across all three modules + tool; structure remains | Extract a shared `loadVisibleSuite`/`loadVisibleCase` + content/visibility PATCH-split kernel; route web-auto through it |
| F12 | `run_test_case` (evaluation) runs `runEvalCase` synchronously inside tool execute | Open | Return immediately with an async handle, or cap with a strict timeout |
| F13 | Delegated tester mutations (supervisor `delegate_to_agent`) never invalidate client caches | Known limitation (accepted) | Extend mutation invalidation broadcast to delegation sub-tree events |
| F14 | Ambient context is client-assembled and injected server-side without validation; `sharedStateEnabled` gate covers only `activeResourceData` (URL/resource-id always pushed) | Open | Server-side shape validation in `extract-run-input.ts`; extend the gate; document the trust domain ("ambient context = client") |
| F15 | Web Auto still executes LLM evaluation after deterministic assertions fail | Verdict precedence is correct (deterministic failure → `failed`) | Skip the LLM evaluation call when `allDeterministicPassed === false` (cost optimization) |
| F16 | Single-case runs persist nothing; agent-triggered `run_test_case` executions are untraceable | Open | Write a lightweight audit record (dedicated table or `entity_run`) for agent-triggered runs |
| F20 | `estimateOutputTokens` uses whitespace×1.3 — Chinese replies under-counted by ~an order of magnitude | Open | Character-count/4 approximation or a lightweight tokenizer |
| F21 | MCP calls lack AbortSignal — timed-out requests keep occupying pool connections | Accepted V1 trade-off (documented in code) | Expose AbortSignal from the MCP provider pool |
| F22 | "New Chat" clears agent state without re-push — ambient context silently lost until editor data changes | Known limitation (accepted) | Force a state re-push after the reset in `RightPanel.tsx` |
| F23 | Trend summary fills `passRate` (all) and `averageScore` (evaluation) but not `durationMs`/`averageScore` for verification/web-auto | Docs overstate | Either fill `durationMs` (from run timestamps) or align §4.4/§4.4-adjacent claims with reality |
| F24 | Docs backlog items (HTML reports, live SSE in chat, one-click RCA) not implemented | Roadmap | Track as milestones, not defects |
| INFRA | Drizzle migration snapshot chain broken since 0017 — `drizzle-kit generate` blocks on interactive rename prompts | Hand-written migrations 0020/0021 follow the repo precedent | Repair interactively: checkout each historical schema state, run `generate`, answer rename prompts, rename snapshots to journal tags; or `introspect` a fully-migrated dev DB |

### 7.1 Verification Checklist for Future Changes

- Tool count changes must update: `tester-tools.server.ts`, `prompt.ts` (count + tool guidance), §2.2/§4/§6 here, and the tool-result subscriber list if a mutation tool is added.
- Any new run/execution path must gate on suite visibility + `enabled` and reuse `visibilitySql` (no hand-rolled predicates).
- `delete_test_case` re-enable requires: uncommenting the mount, updating the prompt's "Deletion is human-only" boundary, and re-adding the tool spec here.
