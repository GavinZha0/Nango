# Evaluation Subsystem

Stochastic LLM-as-Judge quality assessment for agent conversations.
Complementary to **Verification** (deterministic assert-on-output).

---

## 1. Core Concepts

- **Eval Suite** — groups test cases targeting one agent (builtin or
  backend). Selects an evaluator agent and a set of dimensions.
- **Eval Case** — multi-turn conversation script plus case-level
  criteria (expectation, keywords, metrics, etc.).
- **Eval Run** — one execution of a suite. Created when the user
  clicks Run; the actual case loop runs asynchronously in the
  background.
- **Evaluator Agent** — a builtin agent with `role = 'evaluator'`.
  Returns structured scores via the `submit_evaluation_scores` tool.

---

## 2. Evaluation Architecture & Unified Assertions

```
┌─────────────────────────────────────────────────────────┐
│  Builtin Evaluation Dimensions (8 across 4 categories)  │
│  Task & Capabilities · Knowledge & Quality              │
│  Safety & Persona · Language & Formatting               │
├─────────────────────────────────────────────────────────┤
│  Unified Assertions (per-case AssertionSpec[])          │
│  tool_call · metric · llm_dim · llm_custom              │
│  duration_s · output_chars · tool_calls/failures/blocked │
└─────────────────────────────────────────────────────────┘
```

**Builtin Dimensions** — 8 specialized dimensions grouped into 4 categories (`DIMENSION_CATEGORIES`):
1. **Task & Capabilities**: `task-completion`, `tool-correctness`
2. **Knowledge & Quality**: `faithfulness`, `code-quality`
3. **Safety & Persona**: `safety`, `tone-persona`
4. **Language & Formatting**: `fluency`, `format-compliance`

Each dimension contains a tailored prompt template following DeepEval/RAGAS best practices (OBJECTIVE → STEPS → RULES → RUBRIC). Suite-level dimensions are selected on `eval_suite.dimensionIds` and merged into the evaluation checklist alongside case-level items.

**Unified Assertions** — per-case `assertions: AssertionSpec[]` validated against `assertionSpecSchema` (`src/lib/assertions/types.ts`):
- **`text_match`**: deterministic keyword, substring, and regex matching (`contains`, `not_contains`, `matches`) directly on response text with optional `caseSensitive` toggle (zero model invocation, instant evaluation).
- **`jsonpath`**: evaluates JSONPath queries against structured outputs (`$.path`) or response text (`$.text contains "..."`).
- **`js_expression`**: evaluates JavaScript expressions in a hardened VM context (`result.status === "ok"`, `text.includes("...")`).
- **`tool_call`**: evaluates tool execution counts, arguments subset matching, or failure/blocked frequencies (`calls`, `failed`, `blocked`).
- **`metric`**: checks multi-turn conversation and performance metrics (`duration_s`, `output_chars`, `total_tool_calls`, `tool_failures`, `tool_blocked`).
- **`llm_dim`**: evaluates against one of the predefined dimension rubrics above.
- **`llm_custom`**: natural language semantic criteria (`expectation`, `unexpectation`, `reference`, `context`).

*Note on structured Agent output*: When an Agent outputs JSON (direct JSON payload or formatted in a markdown ` ```json ` code block), the runner automatically deserializes it so `jsonpath` and `js_expression` can inspect object properties directly alongside `text`.

**Suite Variables (Literal Variables)** — defined on `eval_suite.variables`.
Literal variables (e.g. `TARGET_PHRASE`, `THRESHOLD`, `ENVIRONMENT`) are resolved
at suite start and injected into `runDeterministicChecks` → `evaluateAssertions`:
- In JS expression assertions: accessible via `variables.KEY` and bare `KEY`.
- In JSONPath / template substitutions: accessible via `{{variables.KEY}}`.
- Strict security boundary: `allowCredentials: false`. Credential variables are prohibited in Evaluation suites and fail closed with `status: "errored"` without calling any agent models.

---

## 3. Execution Flow

### 3.1 Suite Run (Async Batch Mode)
```
User clicks "Run Suite"
    │
    ▼
API returns 202 + runId (fire-and-forget)
    │
    ▼
Background loop (serial, alphabetical by case name):
    │
    ├─ ① Dispatch target agent (builtin or backend)
    │     via runner.start({ mode: "sync", initiator: "evaluator" })
    │
    ├─ ② Run deterministic checks (code)
    ├─ ② Run deterministic checks (code)
    │     tool_calls · metrics (duration_s, output_chars, tool counts)
    │     Output: per-item pass/fail verdict
    │
    ├─ ③ Assemble evaluator prompt
    │     Evaluation brief with atomic checklist [CHECK ITEM 0], [1], ...
    │     combining suite dimensions and case-level LLM assertions
    │     + conversation transcript + deterministic execution facts
    │
    ├─ ④ Dispatch evaluator agent
    │     Calls submit_evaluation_scores tool once
    │     Returns: item_scores: [{ index, score: 1..5, reason }]
    │     + optional overall feedback
    │
    ├─ ⑤ Compute item and case verdicts
    │     Each item passes if score >= threshold (default 3 on 1-5 Likert scale)
    │     Case status = passed only if all deterministic and LLM items pass
    │
    ├─ ⑥ Write eval_case_result + publish SSE
    │
    └─ (next case)

Finalize: aggregate passed/failed/errored counts → eval_run
```

### 3.2 Single Case Run (Synchronous Playground Mode)
- **Zero DB pollution**: `POST /api/eval-cases/[id]/run` executes the pipeline synchronously inline without persisting `eval_run` or `eval_case_result` records (mirrors Verification & Web Auto).
- **Direct UI Feedback**: Returns `RunEvalCaseResult` JSON directly (200 OK) or streams two-phase results via request-scoped NDJSON (`Accept: application/x-ndjson` or `?stream=true`).
- **Streaming Channel Contract**:
  - **Batch runs (Suite/Group)** use the shared SSE channel (`/api/runs/stream`) — asynchronous, persisted in DB (`eval_run`), lightweight status frames broadcasted across user tabs.
  - **Playground single-case runs** use request-scoped NDJSON streams — ephemeral, zero DB writes, point-to-point. Emits Phase 1 (`target_complete`) immediately so the user can inspect target output and messages while Phase 2 evaluates in background. Client disconnect or cancellation (`AbortController`) terminates remaining evaluator dispatches.
- **Thread Replay**: Ephemeral conversation messages are retrieved on-demand via `/api/eval-runs/playground/messages?threadId=...` bounded by session owner authentication.

Recovery: stranded `eval_run` rows (`status='running'`) are swept
to `errored` on boot via `instrumentation.ts`.

### 3.3 Evaluator-Not-Configured System Contract

A case that depends on an LLM evaluator — any judge-dependent assertion
(`llm_custom`, `llm_dim`) **or** a suite that selects
`dimensionIds` (dimensions are judge-scored) — cannot produce a
verdict when the suite binds no Evaluator Agent (`evaluatorAgentId` is null):

- **Dimension-bearing suites** (`dimensionIds.length > 0`): every case
  short-circuits to `errored` **before dispatching the target agent** — this is
  a suite-level configuration error.
- **Judge-only cases** (all assertions judge-dependent): short-circuit to
  `errored` before dispatch — there is nothing executable without a judge.
- **Mixed cases** (deterministic + judge assertions): still run. Deterministic
  assertions are evaluated and can expose real defects. Deterministic failure →
  `failed` (score `0`, fail-fast); deterministic pass → `errored` (score `null`).
- **Pure deterministic cases** (no judge assertions, no dimensions): run
  normally and pass/fail on deterministic checks (score `5` / `0`). This
  deterministic-only mode does not require an evaluator.

Result rows: judge assertions that were not evaluated are persisted with
`skipped: true`, `ok: false`, **no numeric `score`**, and an explanatory
`reason`. They render amber **"Not evaluated"** and are excluded from failed
tallies. The same `skipped` placeholders fill judge rows on fail-fast,
evaluator-failure, and config-error paths so `assertion_results` stays aligned
1:1 with the case's `assertions` array (absolute indices preserved).

**Contract: `errored` ⇒ `score` and `assertionScore` are `null`. A missing
evaluator is a configuration problem — never a graded `0` ("model is bad") and
never a silent green pass with unjudged assertions.**

---

## 4. Scoring & Levels

**Item-level (Discrete Likert Scale)** — Evaluator agents grade each checklist item on an integer 1–5 scale:
- **5 (Excellent)**: Fully satisfies all criteria with exceptional quality.
- **4 (Good)**: Meets core requirements with only minor, negligible imperfections.
- **3 (Acceptable / Pass Threshold)**: Meets essential requirements adequately; default passing cutoff.
- **2 (Marginal / Substandard)**: Significant omissions, noticeable errors, or poor quality.
- **1 (Complete Failure)**: Wholly fails requirement, toxic/harmful, or completely hallucinated.

**Case-level** — overall score combines deterministic checks and judge scores. A case passes if all deterministic assertions succeed and all evaluated judge items achieve `score >= threshold` (default threshold is 3).

**Suite-level & Run Aggregates** — item-level scores (1-5 Likert scale) are displayed directly. Suite-level pass/fail status is computed based on case pass rates, with configurable thresholds (DB keys `eval.threshold.*`):

| Level | Default | Color |
|---|---|---|
| Excellent | ≥ 80 | Blue |
| Pass | ≥ 60 | Green |
| Poor | ≥ 40 | Amber |
| Fail | < 40 | Red |

Suite status is `passed` (all cases pass), `failed` (any fails), or `errored` (any runner error). UI shows `8/10 Passed (2 Failed)`.

---

## 5. Evaluator Tool

`submit_evaluation_scores` — server tool injected into evaluator agents (`role = 'evaluator'`) during programmatic dispatch. Tool calls are natively structured (Zod-validated JSON args), making score extraction deterministic vs. parsing free text.

Accepts:
- `item_scores`: `Array<{ index: number, score: number, reason: string }>` where `index` matches `[CHECK ITEM 0]`, `[CHECK ITEM 1]`, etc., `score` is an integer 1–5, and `reason` cites specific conversational evidence.
- `feedback`: optional string providing high-level evaluation feedback.

---

## 6. API Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/eval-suites/[id]/run` | Start async suite run (202 + runId) |
| `POST` | `/api/eval-cases/[id]/run` | Synchronous playground single case run (200, no DB writes) |
| `GET` | `/api/eval-cases/[id]/latest-result` | Latest persisted case result for the case inspector. Visibility-gated via `loadCase` (opaque 404 for foreign private cases). |
| `GET` | `/api/eval-suites/[id]/runs` | Paginated run history |
| `GET` | `/api/eval-runs/[id]` | Run detail + case results |
| `GET` | `/api/eval-runs/[id]/messages` | Conversation replay for a case |
| `GET/POST/PATCH/DELETE` | `/api/eval-suites/**`, `/api/eval-cases/**` | Suite + case CRUD |
| `GET` | `/api/eval-suites/agents` | Agents with eval suites (left panel) |

All routes wrapped by `withEditor` and protected by `canEditResource` / `canViewResource` RBAC checks. Case deletion follows the unified rule across all three test modules: **case author OR suite author OR admin**.

---

## 7. UI Layout

```
┌─────────────────┬────────────────────────────────────────────────────────┐
│ EvalCaseList    │ EvalCaseInspector                                      │
│ Case list with  │ ┌───────────────────────┬────────────────────────────┐ │
│ verdict badges, │ │ Conversation turns    │ Header: [#seq] [Duration]  │ │
│ enable toggles, │ │ + Criteria editor     │ Score bar & dimension bars │ │
│ and action buttons│ + Response replay tab │ Detailed criteria & feedback│ │
│                 │ └───────────────────────┴────────────────────────────┘ │
└─────────────────┴────────────────────────────────────────────────────────┘
```

- **Suite Run button**: Async batch run with progress via `RecentRunsBanner` and SSE multiplexing on `/api/runs/stream`.
- **Case Run button**: Synchronous playground execution returning inline `localOutcome` without writing to `eval_run`.
- **Response tab**: Fetches conversation from `entity_run_event` via the eval run's thread ID.
- **Criteria section**: Shows per-item ✓/✗ verdicts (keywords, tools, metrics) with actual values for failures.

---

---

## 6. Unified Judge Engine & Configuration (`judge.server.ts`)

LLM-as-Judge evaluation is unified across **Evaluation** and **Web Auto** via the shared kernel module [`src/lib/evaluation/judge.server.ts`](file:///d:/AI/nango/src/lib/evaluation/judge.server.ts):

### 6.1 Configuration Keys & Defaults

| Key / Constant | Default | Scope | Description |
|---|---|---|---|
| `CONFIG_KEY_EVALUATOR_TIMEOUT` (`evaluator_timeout_seconds`) | `300s` (5 min) | Process / System Config | Timeout for evaluator agent dispatch. Protects against slow or hanging judge models. |
| `eval_suite.case_timeout_sec` | `300s` | Suite column | Per-case limit for target agent execution. Required field; unified across Verification / Evaluation / Web Auto; suites impose no total-duration limit. |
| `DEFAULT_EVAL_MAX_RETRIES` | `2` | Kernel Option | Maximum dispatch attempts before marking evaluation as failed. When set to `0`, evaluation skips. |

### 6.2 Dispatch & Retry Mechanism

- **Unified Timeout Wrapping**: All synchronous agent runs (`runner.start({ mode: "sync" })`) are wrapped by `withStepTimeout<T>(promise, timeoutMs, stepName)` exported from `judge.server.ts` and shared between `eval-runner.ts` and `judge.server.ts`.
- **System Warning on Retry**: If an evaluator run completes without successfully calling `submit_evaluation_scores`, or encounters a transient failure, subsequent retries automatically append `EVALUATOR_RETRY_SYSTEM_WARNING` to the prompt instructing the model to invoke the tool.
- **Reverse Traversal & Schema Validation**: `extractEvaluatorScoresDetailed` inspects `entity_run_event` in reverse chronological order to read the latest tool call, strictly enforcing Zod schema validation against `submitEvaluationScoresSchema`.
- **Differentiated Error Diagnostics**: Failures distinguish between:
  1. `step timed out after Xs` (execution SLA exceeded)
  2. `Evaluator agent run failed: <errorMessage>` (model error or quota exhaustion)
  3. `Evaluator did not call submit_evaluation_scores` (missing tool invocation)
  4. `Evaluator called submit_evaluation_scores but arguments were not valid JSON` (malformed payload)
  5. `Evaluator called submit_evaluation_scores but arguments failed schema validation: <field error>` (Zod violation)

---

## 7. Key Files

| File | Purpose |
|---|---|
| `lib/evaluation/types.ts` | Dimensions, criteria schema, level config, shared types |
| `lib/evaluation/config.ts` | Scoring thresholds, level system |
| `lib/evaluation/judge.server.ts` | Unified LLM-as-Judge dispatcher, timeout guard, score extraction |
| `lib/evaluation/runtime-tools.ts` | `submit_evaluation_scores` tool |
| `lib/evaluation/deterministic-checks.ts` | Code-verifiable criteria checks |
| `lib/evaluation/prompt-builder.ts` | Evaluator prompt assembler |
| `lib/evaluation/eval-runner.ts` | Single case execution |
| `lib/evaluation/run-orchestrator.ts` | Suite-level background orchestrator |
| `lib/evaluation/recovery.ts` | Boot-time stranded run sweep |
| `lib/evaluation/storage.ts` | DB access layer |
| `lib/evaluation/access.ts` | Permission helpers |
| `hooks/useEvaluationRunStream.ts` | SSE hook for live run tracking |
| `components/main-panels/evaluation/` | UI components |

---

## 9. Future

- **Custom dimensions** — user-authored dimensions with custom prompts
  (`builtin: false`).
- **Batch agent runs (UI)** — agent-level batch evaluation exists at the API
  layer (`POST /api/eval-runs` with `agentId`); a left-panel "run all" entry
  is still open.
- **Score trending** — per-case score history chart across runs.
- **Schedule-driven evaluation** — hook suites into the scheduler.
