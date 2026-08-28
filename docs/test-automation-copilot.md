# Test Automation Copilot & Closed-Loop QA Architecture

Status: Active Specification · Target Subsystems: Verification (P1), Evaluation (P2), Web Auto (P3) · Last Updated: 2026-08-27

---

## 1. Product Positioning & Core Philosophy

Nango currently supports **Single-Form Shared State & Co-Editing** (`propose_page_edit` via `docs/shared-state.md`), which allows the Copilot agent to stage non-destructive field-level edits into the currently open editor form.

**Test Automation Copilot** extends this capability from single-field editing into a **full-lifecycle, closed-loop QA Copilot** across three test harnesses:
1. **Verification Subsystem (`docs/verification.md`)**: Deterministic MCP Tool & Workflow testing.
2. **Evaluation Subsystem (`docs/evaluation.md`)**: Stochastic LLM-as-Judge conversational agent evaluation.
3. **Web Auto Subsystem (`docs/web-auto.md`)**: Playwright-based browser end-to-end automation.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                             Closed-Loop QA Copilot Lifecycle                                 │
│                                                                                             │
│  [1. Schema/Spec] ──► [2. Matrix Plan] ──► [3. Batch Creation] ──► [4. Isolated Drafts]     │
│   (PageCtx / Read)    (Chat Preview / HITL) (create_*_cases)       (enabled = false)        │
│                                                                            │                │
│                                                                            ▼                │
│  [7. Report / Outcome] ◄── [6. Smart Remediation] ◄── [5. Failure RCA] ◄── [Execute Suite]  │
│   (HTML / Chat / Outcome)  (update_*_case)            (get_*_run_details) (Manual / Trigger)│
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Core Tenets & Differentiations

| Dimension | Form Copilot Edit (`propose_page_edit`) | Test Automation Copilot (This Architecture) |
| :--- | :--- | :--- |
| **Operation Target** | Single active resource open in frontend editor form | N sibling test case rows in DB + Test Run diagnostics + Remediation |
| **Persistence Model** | Staged in React memory; user clicks Save button | Directly inserted into DB with safe write barrier |
| **Write Barrier** | Amber Save Button (`bg-amber-600`) | **`enabled = false`** default state (isolated from regression test runs) |
| **Runtime Layer** | Frontend browser tool (`useValidatedFrontendTool`) | Server-side tools (`defineTool` with RBAC, DB transactions & Zod validation) |
| **Lifecycle Scope** | Edit single form field | **Closed Loop**: Schema synthesis ➔ Generation ➔ Triage ➔ Remediation ➔ Reporting |

### 1.2 Prerequisites — Frontend Enabled/Draft UI Unification

> [!IMPORTANT]
> Before implementing authoring tools, the three subsystems' frontend Case
> list/tree UIs must be unified to consistently render `enabled` state and
> provide toggle controls. Current status:
>
> | Subsystem | disabled case rendering | enabled toggle UI |
> | :--- | :--- | :--- |
> | Verification CaseTree | ✅ `opacity-50` when `!enabled` | ❌ No toggle control |
> | Web Auto Editor | ✅ `[draft]` text label | ❌ No toggle control |
> | Evaluation | ❌ **No rendering at all** | ❌ No toggle control |
>
> **Required before P1**: All three subsystems must render a visible
> `[AI Draft]` badge for `enabled = false` cases and provide a toggle
> (checkbox or switch) to enable/disable individual cases. This frontend
> unification is tracked as a separate prerequisite task.

---

## 2. End-to-End Closed-Loop Workflow

### Step 1: Context & Schema Acquisition
- **Primary Channel (Interactive)**: When viewing a suite (`/verification/[id]`, `/evaluation/[id]`, `/web-auto/[id]`), `state.context.activeResourceData` carries the suite context and open target spec (e.g. MCP tool inputSchema). The agent perceives it ambiently with zero token cost.
- **Fallback Channel (Autonomous / Delegated)**: When running headless or across suites, the agent calls dedicated server read tools:
  - `get_mcp_tool_schema(serverId, toolName)`
  - `get_target_agent_spec(agentId)`

### Step 2: Test Matrix Planning & Optional Chat Preview
- Agent formulates a balanced test matrix:
  - **Happy Path**: Standard baseline inputs and typical business workflows.
  - **Boundary Cases**: Numeric min/max limits, empty/long strings, boundary arrays.
  - **Negative / Defense Cases**: Missing required fields, invalid enum types, expecting `{ isError: true }`.
- **Conversational Preview Flexibility**:
  - The Test Expert Agent prompt is configured to offer the user a choice:
    1. *Quick Mode*: Directly generate and insert cases into the left panel as drafts.
    2. *Preview Mode*: Output a markdown table in chat first, allowing the user to review or refine combinations before persisting.

### Step 3: Batch Case Creation & Safe Write Barrier
- Agent calls `create_<kind>_cases({ suiteId?, mcpServerId?, cases: [...] })`.
- **Suite Resolution**:
  - If `suiteId` is provided, cases are inserted into the specified suite.
  - If `suiteId` is omitted, the tool auto-creates a new suite (following the existing Lazy Suite pattern in `POST /api/verification-cases`).
- **Write Barrier Contract**:
  - All generated cases are persisted with **`enabled = false`** and `createdBy = ctx.userId`.
  - Name de-duplication: cases with existing names in the same suite are skipped and reported in `{ skipped: [{ name, reason }] }`.
  - Batch size cap: `maxCases = 20` per call to prevent runaway generation.
- **UI Reflection**:
  - Left panel CaseTree revalidates via SWR/SSE.
  - Newly generated cases display an **`[AI Draft]`** badge.
  - User reviews each case individually in the inspector and toggles `enabled` when satisfied.

### Step 4: Test Execution & Result Diagnostics
- When tests execute (manually by user or triggered programmatically), execution details are persisted to `verification_case_result` / `eval_case_result` / `web_auto_case_result`.
- Agent calls diagnostic read tools to inspect run telemetry:
  - `get_verification_run_details({ runId })`
  - `get_eval_run_details({ runId })`
  - `get_web_auto_run_details({ runId })`
- Returns: execution status, actual input/output snapshots, assertion failure diffs, execution duration, and Evaluator dimension scores.

### Step 5: Root Cause Analysis (RCA) & Triage
The Agent analyzes failures into 4 actionable categories:
1. **Target Tool Bug**: Unexpected 500 status, unhandled exception, schema violation in tool return.
2. **Assertion Over-Constraint / Drift**: Tool output is logically correct, but assertion rules were too strict (e.g. dynamic timestamps, localized strings).
3. **Schema / Interface Upgrade**: Tool signature or upstream API changed, rendering existing test case inputs obsolete.
4. **Environment / Flaky Failure**: Timeout, network glitch, rate-limit.

### Step 6: Smart Case Remediation (Repair)
When root cause is identified as **Assertion Drift** or **Schema Upgrade**, the agent can fix the test case:
- Agent calls remediation tools:
  - `update_verification_case({ caseId, input?, assertions?, name?, enabled? })`
  - `update_eval_case({ caseId, turns?, criteria?, name?, enabled? })`
  - `update_web_auto_case({ caseId, scriptContent?, assertions?, name?, description?, enabled? })`
- Modifies the case in place, adjusts assertions or input payloads, and updates `updatedAt`.

### Step 7: Dual-Mode Reporting & Outcome Archival
- **Chat Inline Summary**: Concise breakdown of total runs, pass rate, failure root causes, and suggested fixes.
- **Rich HTML Visual Report**: Generates an interactive HTML artifact with pass/fail pie charts, latency histograms, and expandable failure diff cards.
- **Outcome Archival**: Persists the test report into Nango's Outcome system via `save_outcome` for historical compliance and team review.
- The agent offers both output modes and lets the user choose per request.

---

## 3. Server Tool Specifications & Architecture

### 3.1 Tool Registration Model

Authoring tools are registered in the **Builtin Tools Catalog**
(`src/lib/builtin-tools/catalog.ts`) under a new `"testing"` category.

> [!IMPORTANT]
> **Catalog `build` signature extension required.** The current
> `BuiltinToolEntry.build` is `() => ToolDefinition` (zero-arg factory).
> Authoring tools need `userId` for RBAC. The `build` signature must be
> extended to `(ctx?: BuiltinToolBuildContext) => ToolDefinition`, where:
> ```typescript
> export interface BuiltinToolBuildContext {
>   userId: string;
> }
> ```
> This is backward-compatible — existing zero-arg tools ignore the
> optional parameter. The dispatch code in `runner/dispatch/builtin.ts`
> (which calls `buildBuiltinTools(names)`) must be updated to pass the
> build context through.
>
> `BuiltinToolCategory` must also be extended:
> ```typescript
> export type BuiltinToolCategory = "sandbox" | "search" | "outcomes" | "testing";
> ```

**Agent binding**: Tools are bound to agents via the `builtin_agent_tool`
junction table with `toolType = "builtin_tool"` and `builtinTool` matching
the catalog entry's `name` (e.g. `"create_verification_cases"`). The
`BuiltinAgentEditor` UI will automatically render the new `testing`
category as a checkbox group.

### 3.2 Context Injection Pattern — Closure Capture

> [!IMPORTANT]
> `defineTool` (re-exported from `@copilotkit/runtime/v2`) has execute
> signature `(args: TArgs) => Promise<TResult>`. There is **no second
> `runContext` parameter**. All runtime context (userId, agentId) must be
> **captured via closure** at factory build time. This is the established
> pattern throughout the codebase (e.g. `buildGetCurrentDatetimeTool`,
> `buildExtractDatasetTool`).

### 3.3 File Structure

```
src/lib/authoring/
├── build-case-authoring-tool.ts      # Shared batch creation factory
├── build-case-remediation-tool.ts    # Shared case update/repair factory
├── verification-authoring-tools.ts   # create_verification_cases, update_verification_case, get_mcp_tool_schema
├── eval-authoring-tools.ts           # create_eval_cases, update_eval_case, get_target_agent_spec
└── web-auto-authoring-tools.ts       # create_web_auto_cases, update_web_auto_case
```

### 3.4 Shared Creation Factory (`buildCaseAuthoringTool`)

```typescript
// src/lib/authoring/build-case-authoring-tool.ts
import "server-only";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";

export interface CaseAuthoringConfig<TCase, TExtra extends z.ZodRawShape = {}> {
  kind: "verification" | "evaluation" | "web_auto";
  toolName: string;
  description: string;
  caseSchema: z.ZodType<TCase>;
  /** Optional subsystem-specific outer parameters (e.g. mcpServerId for Verification). */
  extraParameters?: TExtra;
  maxCases?: number; // Default: 20
  /**
   * Resolve or auto-create a suite. When suiteId is provided, validate
   * it exists and is editable. When suiteId is null, auto-create a new
   * suite following the Lazy Suite pattern using extra context.
   */
  resolveSuite: (
    suiteId: string | null,
    userId: string,
    extra: Record<string, unknown>,
  ) => Promise<{ suiteId: string; suiteName: string }>;
  /**
   * Insert validated cases as disabled drafts. Handles name de-dup
   * internally and returns created vs skipped arrays.
   */
  insertBatch: (
    suiteId: string,
    cases: TCase[],
    userId: string,
  ) => Promise<{
    created: Array<{ id: string | number; name: string }>;
    skipped: Array<{ name: string; reason: string }>;
  }>;
}

/**
 * Build a batch case creation tool. The returned ToolDefinition captures
 * `userId` via closure — defineTool.execute receives only `args`.
 *
 * @param config  Per-subsystem configuration.
 * @param ctx     Runtime context captured at build time (from dispatch).
 */
export function buildCaseAuthoringTool<TCase, TExtra extends z.ZodRawShape = {}>(
  config: CaseAuthoringConfig<TCase, TExtra>,
  ctx: { userId: string },
): ToolDefinition {
  const maxCases = config.maxCases ?? 20;

  const baseSchema = {
    suiteId: z.string().uuid().optional()
      .describe("Target suite UUID. Omit to auto-create a new suite."),
    ...(config.extraParameters ?? {}),
    cases: z
      .array(config.caseSchema)
      .min(1)
      .max(maxCases)
      .describe(`Array of test cases to generate (max ${maxCases})`),
  };

  return defineTool({
    name: config.toolName,
    description: config.description,
    parameters: z.object(baseSchema).strict(),
    // CONTRACT: execute receives only (args). userId is closure-captured.
    execute: async (rawArgs: Record<string, unknown>) => {
      const { suiteId, cases, ...extra } = rawArgs as {
        suiteId?: string;
        cases: TCase[];
        [key: string]: unknown;
      };

      // 1. Suite resolution (validate existing or auto-create)
      const suiteCtx = await config.resolveSuite(
        suiteId ?? null,
        ctx.userId,
        extra,
      );

      // 2. Batch insert with enabled = false, createdBy = userId
      const result = await config.insertBatch(
        suiteCtx.suiteId,
        cases,
        ctx.userId,
      );

      return {
        ok: true,
        kind: config.kind,
        suiteId: suiteCtx.suiteId,
        createdCount: result.created.length,
        created: result.created,
        skippedCount: result.skipped.length,
        skipped: result.skipped,
        message: `Created ${result.created.length} draft case(s) (disabled by default) in suite '${suiteCtx.suiteName}'.`,
      };
    },
  });
}
```

### 3.5 Shared Remediation Factory (`buildCaseRemediationTool`)

```typescript
// src/lib/authoring/build-case-remediation-tool.ts
import "server-only";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";

export interface CaseRemediationConfig<TPatch, TId extends number | string = number | string> {
  kind: "verification" | "evaluation" | "web_auto";
  toolName: string;
  description: string;
  /** Zod schema for partial patch. Must use .strict(). */
  patchSchema: z.ZodType<TPatch>;
  /** Per-subsystem case ID schema (z.number().int() or z.string().uuid()). */
  caseIdSchema: z.ZodType<TId>;
  resolveCase: (
    caseId: TId,
    userId: string,
  ) => Promise<{ suiteId: string; caseName: string }>;
  updateCase: (
    caseId: TId,
    patch: TPatch,
    userId: string,
  ) => Promise<void>;
}

/**
 * Build a case remediation (update/repair) tool. Closure-captures userId.
 */
export function buildCaseRemediationTool<TPatch, TId extends number | string = number | string>(
  config: CaseRemediationConfig<TPatch, TId>,
  ctx: { userId: string },
): ToolDefinition {
  return defineTool({
    name: config.toolName,
    description: config.description,
    parameters: z
      .object({
        caseId: config.caseIdSchema.describe("ID of the test case to remediate"),
        patch: config.patchSchema.describe("Fields to update on the test case"),
      })
      .strict(),
    // CONTRACT: execute receives only (args). userId is closure-captured.
    execute: async ({ caseId, patch }) => {
      const caseInfo = await config.resolveCase(caseId as TId, ctx.userId);
      await config.updateCase(caseId as TId, patch, ctx.userId);

      return {
        ok: true,
        kind: config.kind,
        caseId,
        message: `Remediated test case '${caseInfo.caseName}'.`,
      };
    },
  });
}
```

---

## 4. Subsystem Contracts & Schema Definitions

> [!IMPORTANT]
> **Primary key types differ across subsystems.** Verification and
> Evaluation cases use `bigint` (JS `number`), while Web Auto cases use
> `uuid` (JS `string`). Each subsystem's remediation tool must use the
> precise `caseIdSchema` for its PK type — no generic `z.union`.

### 4.1 Verification Subsystem (P1)

**Source**: reuses existing schemas from `src/lib/verification/wire-schemas.ts`.

#### `create_verification_cases` — Tool Parameters

```typescript
// Tool-level parameters (outer)
z.object({
  suiteId: z.string().uuid().optional(),
  mcpServerId: z.string().uuid().optional()
    .describe("MCP Server UUID. Used for auto-creating a suite when suiteId is omitted."),
  cases: z.array(verificationCaseCreateSchema).min(1).max(20),
}).strict()
```

#### Case Schema

```typescript
// Reuses caseInputSchema and assertionsArraySchema from wire-schemas.ts.
// Agent MUST specify the assertion `type` field explicitly (no auto-inference).
export const verificationCaseCreateSchema = z.object({
  name: z.string().min(1).max(120).describe("Descriptive name for the test scenario"),
  toolName: z.string().min(1).max(200).describe("MCP tool name this case targets"),
  input: caseInputSchema.default({}).describe("JSON parameter payload matching the tool's inputSchema"),
  assertions: assertionsArraySchema.default([]).describe(
    "Deterministic output assertions. Each entry MUST include an explicit `type` field: " +
    "'json_schema', 'jsonpath_equals', or 'js_expression'. Do NOT omit `type`."
  ),
}).strict();
```

#### Patch Schema (Remediation)

```typescript
export const verificationCasePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  input: caseInputSchema.optional(),
  assertions: assertionsArraySchema.optional(),
  enabled: z.boolean().optional(),
}).strict();

// caseIdSchema: z.number().int()  (bigint PK)
```

#### Companion Read Tools

- **`get_mcp_tool_schema(serverId, toolName?)`**: Returns the tool's `inputSchema` (JSON Schema) and description from the MCP provider pool. When `toolName` is omitted, returns all tools for the server.
- **`get_verification_run_details({ runId })`**: Returns suite run status, per-case `inputSnapshot`, `resultPayload`, `assertionResults` (with expected vs actual diffs), `durationMs`, and `error`.

---

### 4.2 Evaluation Subsystem (P2)

**Source**: reuses existing schemas from `src/lib/evaluation/types.ts`.

> [!IMPORTANT]
> **Data model alignment**: The `eval_case` table stores conversation
> inputs as `turns: jsonb` with shape `EvalTurn[] = { userMessage: string }[]`
> — NOT `{ role, content }`. The `criteria` column uses
> `evalCriteriaSchema` with fields `expectation`, `reference`, `issue`,
> `context`, `assertions`, `tool_calls`, `expected_keywords`,
> `unexpected_keywords`, `max_duration_s`, `max_output_tokens`,
> `max_tool_calls`. Do NOT use non-existent field names like `rubric`,
> `referenceAnswer`, or `prompt`.

#### Case Schema

```typescript
// Reuses evalCriteriaSchema from src/lib/evaluation/types.ts.
export const evalCaseCreateSchema = z.object({
  name: z.string().min(1).max(120).describe("Case title"),
  turns: z.array(z.object({
    userMessage: z.string().min(1).describe("User message sent to the target agent"),
  })).min(1).describe("Conversation turn inputs (user-side only; agent responses are captured at runtime)"),
  criteria: evalCriteriaSchema.optional().describe(
    "Evaluation criteria. Key fields: `expectation` (expected outcome), " +
    "`reference` (ground truth answer), `issue` (known problem), " +
    "`tool_calls` (expected tool names), `expected_keywords`, " +
    "`unexpected_keywords`, `max_duration_s`, `max_output_tokens`, `max_tool_calls`."
  ),
}).strict();
```

#### Patch Schema (Remediation)

```typescript
export const evalCasePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  turns: z.array(z.object({
    userMessage: z.string().min(1),
  })).optional(),
  criteria: evalCriteriaSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();

// caseIdSchema: z.number().int()  (bigint PK)
```

#### Companion Read Tools

- **`get_target_agent_spec(agentId)`**: Returns the target agent's name, description, prompt excerpt, bound tools, and model configuration for generating relevant evaluation scenarios.
- **`get_eval_run_details({ runId })`**: Returns run status, per-case evaluator scores (baseline, dimension scores, criteria score), feedback narrative, and deterministic check results (keyword matches, tool call matches, metric violations).

---

### 4.3 Web Auto Subsystem (P3)

**Source**: reuses existing schemas from `src/lib/web-auto/assertions.ts`.

> [!IMPORTANT]
> **Primary key difference**: Web Auto cases use `uuid` (string) PK,
> unlike Verification/Eval which use `bigint` (number). The remediation
> tool's `caseIdSchema` must be `z.string().uuid()`.

#### Case Schema

```typescript
// Reuses webAutoAssertionsArraySchema from src/lib/web-auto/assertions.ts.
// Web Auto assertions have two types:
//   - js_expression: { type, label, expression }
//   - llm_expectation: { type, label, expectation }
// Note: Web Auto assertions include a `label` field (unlike Verification assertions).
export const webAutoCaseCreateSchema = z.object({
  name: z.string().min(1).max(120).describe("User journey scenario title"),
  description: z.string().optional(),
  scriptContent: z.string().min(1).describe("Playwright automation script body"),
  assertions: webAutoAssertionsArraySchema.default([]).describe(
    "Assertions array. Each entry MUST include `type` ('js_expression' or " +
    "'llm_expectation') and a `label` field."
  ),
}).strict();
```

#### Patch Schema (Remediation)

```typescript
export const webAutoCasePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().optional(),
  scriptContent: z.string().min(1).optional(),
  assertions: webAutoAssertionsArraySchema.optional(),
  enabled: z.boolean().optional(),
}).strict();

// caseIdSchema: z.string().uuid()  (UUID PK)
```

#### Companion Read Tools

- **`get_web_auto_run_details({ runId })`**: Returns run status, per-case execution output, deterministic assertion results, LLM evaluation verdicts, and errors.

---

## 5. Test QA Expert Agent Prompt Engineering

When binding authoring & remediation tools to a dedicated **Test QA Expert Agent**, the system injects a comprehensive QA prompt block:

```markdown
## Test QA Expert Operating Guidelines

### 1. Planning & Preview Policy
- When the user asks for test case generation:
  1. If the user specifies "directly create" or "batch generate", immediately
     synthesize cases and call `create_<kind>_cases`.
  2. Otherwise, offer a brief summary or table in chat with the proposed test
     matrix (Happy Path / Boundary / Negative) and confirm if they wish to
     adjust before persisting.

### 2. Case Generation Principles
- **Equivalence Partitioning**: Group inputs into valid and invalid classes;
  generate at least one case per partition.
- **Boundary Value Analysis**: Test 0, 1, max-1, max, empty string, max
  length, empty array, null/undefined values.
- **Negative Testing**: Intentionally omit required fields or pass invalid
  enums to assert that error envelopes (`isError: true`) are correctly returned.
- **Assertion Authoring Rules**:
  - ALWAYS specify the `type` field explicitly on every assertion. Do NOT
    rely on auto-inference.
  - Prefer structural assertions (`json_schema`) for full payload shape.
  - Use `jsonpath_equals` for deterministic identifiers and status flags.
  - Avoid hardcoding dynamic fields (timestamps, random UUIDs) into exact
    match assertions.
  - For Web Auto assertions, always include a `label` field.

### 3. Diagnosis & Remediation Procedure
- When analyzing test run failures:
  1. Call `get_<kind>_run_details` to retrieve execution logs and assertion diffs.
  2. Categorize the failure: Target Bug vs. Assertion Drift vs. Schema Change
     vs. Flake.
  3. If it is Assertion Drift or Schema Change, propose a remediation patch
     and call `update_<kind>_case` upon user consent.
  4. Provide test results in chat prose or generate a standalone interactive
     HTML report — offer both options and let the user decide.

### 4. Report Generation
- When the user requests a test report:
  1. Offer two presentation modes: chat inline summary or rich HTML page.
  2. For HTML reports, use `generate_html_page` with ECharts for pass rate
     and latency visualizations.
  3. Optionally call `save_outcome` to persist the report as a workspace asset.
```

---

## 6. Cross-Cutting Concerns

### 6.1 Batch Service Reuse
Each subsystem must extract a `create<Kind>CasesBatch()` service function
shared by both the authoring tool and the existing REST case-create route,
so validation logic never forks.

### 6.2 De-duplication
Cases with names already present in the target suite are skipped (not
overwritten) and reported in the `skipped` array of the tool response.
Uses the existing `(suiteId, name)` unique index.

### 6.3 Observability
Authoring tool calls are ordinary server-tool calls — captured in
`entity_run_event` / tool aggregator and shown on the run timeline and
admin trace views.

### 6.4 Failure Contract
All tool `execute` functions return structured `{ isError: true, message }`
on failure (never throw). This is consistent with `wrapToolExecute`
(`AGENTS.md` §19) which wraps thrown exceptions at the pipeline level.

---

## 7. Priorities & Execution Roadmap

| Phase | Core Deliverables | Detailed Tasks | Milestones |
| :--- | :--- | :--- | :--- |
| **Phase 0 (P0)<br>Frontend Prerequisite** | **Enabled/Draft UI Unification** | 1. Add `[AI Draft]` badge + enabled toggle to Verification CaseTree.<br>2. Add enabled rendering + toggle to Evaluation case list (currently missing entirely).<br>3. Verify Web Auto existing `[draft]` label and add toggle.<br>4. Standardize badge styling across all three subsystems. | All three subsystems render and toggle `enabled` state consistently. |
| **Phase 1 (P1)<br>Foundation & Verification** | **Catalog Extension + Verification Closed-Loop** | 1. Extend `BuiltinToolEntry.build` signature to accept optional `BuiltinToolBuildContext`.<br>2. Add `"testing"` to `BuiltinToolCategory`.<br>3. Implement `buildCaseAuthoringTool` & `buildCaseRemediationTool` factories.<br>4. Build `create_verification_cases` (with optional `suiteId` + Lazy Suite), `update_verification_case`, `get_verification_run_details`, `get_mcp_tool_schema`.<br>5. Register tools in catalog & update dispatch to pass build context.<br>6. Craft Test QA Expert Agent prompt block.<br>7. Unit tests: factory, RBAC, de-dup, Zod `.strict()` boundary, Lazy Suite creation. | Verification authoring + diagnostics + remediation end-to-end. |
| **Phase 2 (P2)<br>Evaluation** | **Eval Authoring & Triage** | 1. Build `create_eval_cases`, `update_eval_case`, `get_eval_run_details`, `get_target_agent_spec`.<br>2. Integrate multi-turn prompt perturbation & adversarial scenario generation strategies.<br>3. Register eval tools in catalog. | Evaluation closed-loop functional. |
| **Phase 3 (P3)<br>Web Auto** | **Playwright Script Generation & Diagnostics** | 1. Build `create_web_auto_cases`, `update_web_auto_case`, `get_web_auto_run_details`.<br>2. Integrate static page snapshot source for script generation.<br>3. Register web-auto tools in catalog. | Web Auto closed-loop functional. |
| **Phase 4 (P4)<br>Reporting & Assets** | **Visual Reports & Outcome Archival** | 1. Rich HTML QA Report generator with ECharts pass rate & latency graphs.<br>2. Automated `save_outcome` archival integration.<br>3. End-to-end integration tests & documentation finalization. | Complete QA Automation Copilot Suite. |

---

## 8. Testing Strategy

For each subsystem, mirror `tests/unit/lib/copilot/tool-handler-integration.test.ts`:

1. **Schema boundary tests**: Rejects invalid / unknown case fields via Zod `.strict()`.
2. **Batch cap tests**: Rejects batches exceeding `maxCases`.
3. **RBAC tests**: Rejects non-editor callers and cross-owner / wrong-kind suites.
4. **Write barrier tests**: Confirms all inserted cases have `enabled = false`.
5. **De-dup tests**: Skips cases with names already present in the suite.
6. **Lazy Suite tests**: Auto-creates suite when `suiteId` is omitted.
7. **Remediation tests**: Validates partial patch application and PK type enforcement.
8. **Factory-level parity**: Shared factory produces correct tool definitions for all three subsystems.

---

## 9. Security & Non-Negotiables

1. **Write Barrier**: All created cases MUST default to `enabled = false`.
2. **Strict Zod Boundary**: Tool parameters must use `.strict()`; invalid or unrecognized fields are rejected at the tool boundary.
3. **Multi-Tenant RBAC**: Suite ownership is verified in `resolveSuite` / `resolveCase`; `createdBy` is stamped from authenticated `ctx.userId`. Non-editor callers are rejected.
4. **Credential Safety**: `sanitizeData` strips all secrets before snapshots reach the model.
5. **Explicit Assertion Types**: Agent MUST specify the `type` discriminator on every assertion entry. Relying on the `z.preprocess` auto-inference layer in `wire-schemas.ts` is prohibited in agent-generated payloads to ensure clarity and auditability.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
| :--- | :--- |
| Hallucinated / low-value cases | Write barrier (drafts) + human curation; batch caps; strong coverage prompts. |
| Selector brittleness (Web Auto) | Start with static page snapshots; add live Playwright probe if quality is insufficient. |
| Validation drift | Single Zod source per kind; prompt schema derived via `z.toJSONSchema()`; shared batch service used by both tool and REST route. |
| RBAC / cross-tenant writes | Editor-role check + ownership check in `resolveSuite`; `createdBy` stamped from `ctx.userId`. |
| PK type confusion | Each subsystem uses its precise `caseIdSchema` (`z.number().int()` or `z.string().uuid()`). No generic union. |
