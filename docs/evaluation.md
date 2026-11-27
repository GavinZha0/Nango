# Evaluation Subsystem

Current deterministic and LLM-as-Judge assessment of Agent conversations, complementary to MCP Verification and browser Web Auto.

> **Runtime reference**: audited against `325ee39` on 2026-10-10. This document describes the current implementation, including known limits; it is not a second roadmap.
> **Unified improvement plan**: the former §8 metric/evidence proposal has been reviewed and consolidated into [Auto-Test Improvement §4.5](auto-test-improvement.md#45-integrated-evaluation-model-evidence-and-judge-service). Shared architecture, non-deterministic metrics, priorities, implementation steps and acceptance now live together there. The proposed six dimensions, `accuracy`/`rule`, stable-ID submission and N/A contract are **not yet implemented**.

## 1. Core Concepts

- **Eval Suite** — groups cases targeting one built-in or backend Agent, with an optional evaluator, literal variables, timeout and score threshold. Active dimension selection is case-level `llm_dim` assertions; suite `dimensionIds` remnants are not the executable source of truth.
- **Eval Case** — multi-turn user messages plus `AssertionSpec[]`, combining deterministic checks and optional Judge checks.
- **Eval Run** — persisted suite execution, created before the serial background case loop.
- **Evaluator Agent** — configured built-in Agent used as the Judge; returns structured scores through `submit_evaluation_scores`. Current role/tool isolation has gaps tracked in the unified plan, so selection alone is not a security boundary.

## 2. Current Assertions and Dimensions

### 2.1 Deterministic assertions

The supported authoring contract is `CATEGORY_TYPE_MAPPING.evaluation` in [assertions/types.ts](../src/lib/assertions/types.ts):

| Type | Current purpose |
|---|---|
| `text_match` | Substring, prohibition and regex checks (`contains`, `not_contains`, `matches`), with optional case sensitivity |
| `jsonpath` | Comparisons over parsed structured output or response text |
| `js_expression` | Expressions over evidence plus `variables.KEY`; the current Node VM is not process isolation |
| `tool_call` | Per-tool calls/failures/blocked counts and argument-subset expectations |
| `metric` | `duration_s`, `output_chars`, `total_tool_calls`, `tool_failures`, `tool_blocked` |

`text_match.scope` supports `final_response`, `all_responses` and a specific 1-based `turn`. The form provides scope/turn controls; multi-turn checks without an explicit scope are a runtime configuration error. E5's original last-turn-only problem has been fixed. Do not introduce the old proposal's alternative names `final` or `all_turns`.

Although the shared engine has `json_schema`, Evaluation's current category contract does not advertise it. Numeric `approx`, named-tool result/order checks and a duplicate-call metric are proposed extensions, not current supported operators.

Structured Agent responses may be parsed from JSON or a JSON code fence for deterministic checks. Current normalization can confuse business and infrastructure fields; see A9/E6 in the [shared improvement plan](auto-test-improvement.md). Raw versus parsed evidence is not yet the fully explicit proposed contract.

### 2.2 Current Judge assertions

- **`llm_custom`**: `expectation`, `unexpectation`, `reference`, optional `context`; the current shape permits combinations and uses a generic integer 1–5 rubric.
- **`llm_dim`**: a named built-in dimension. The current eight rubrics in [evaluation/types.ts](../src/lib/evaluation/types.ts) are:

| Category | Current IDs |
|---|---|
| Task & Capabilities | `task-completion`, `tool-correctness` |
| Knowledge & Quality | `faithfulness`, `code-quality` |
| Safety & Persona | `safety`, `tone-persona` |
| Language & Formatting | `fluency`, `format-compliance` |

These are the **existing eight**, not the proposed six. Some overlap or require evidence the current brief does not supply. Unknown dimension IDs can currently fall back to generic prompt text; strict registry validation is part of the shared refactor.

The current brief carries a checklist, deterministic results, tool counters/abnormal summaries and user/assistant text. It does not provide the complete successful tool arguments/results, target tool catalogue or delegated run-tree evidence required by the new metric model.

### 2.3 Literal variables

Suite variables are supplied to deterministic evaluation:

- JS accesses them only through `variables.KEY`; top-level variable spreading was removed to prevent evidence shadowing.
- Supported template fields can use `{{variables.KEY}}`, but resolution is not yet uniform across text expectations, turn messages and Judge criteria (A7/E12).
- Credential variables are disallowed in Evaluation (`allowCredentials: false`); an invalid credential-variable configuration fails before Agent execution.

## 3. Current Execution Flow

### 3.1 Suite run

`POST /api/eval-suites/[id]/run` starts an asynchronous persisted run:

1. Load the suite and enabled cases. Empty/all-disabled suites are rejected before run creation.
2. Create `eval_run`, publish `run_started`, and start a serial background loop.
3. Dispatch the target through `runner.start({ mode: "sync", initiator: "evaluator" })` for each turn, using the suite's `caseTimeoutSec` per turn.
4. Collect each target root run's events, response text and tool statistics. Current target replay passes text-only prior user/assistant messages; a shared thread ID does not guarantee faithful tool-history replay for every backend.
5. Evaluate deterministic assertions. Failed/error checks gate Judge dispatch; completed check results are retained.
6. If needed and configured, build the brief and dispatch the evaluator through the shared Judge runner.
7. Map submitted item scores to the case assertion array and call `determineCaseVerdict`.
8. Persist `eval_case_result`, publish progress, and continue to the next case. Finalize run counts/status and notify.

Agent-level batch execution forwards each suite's timeout. Authorization, argument assembly, error persistence and replay still have the residual gaps listed in the unified plan; this flow is not a claim that a common `TestService` already exists.

A case with zero turns or only blank messages is rejected before target dispatch. The current `some(nonBlank)` check still permits mixed valid/blank turns; the stricter per-turn policy is proposed work.

### 3.2 Single-case playground

`POST /api/eval-cases/[id]/run` executes inline and returns JSON or request-scoped NDJSON (`Accept: application/x-ndjson` or `?stream=true`). A `target_complete` phase lets the UI inspect target output while evaluation proceeds.

- It does **not** create `eval_run` or `eval_case_result` test-history records. Runner target/Judge activity can still create `entity_run` and event records; this is not literally zero database writes.
- Batch progress uses `/api/runs/stream` SSE. Playground output uses the request's NDJSON channel, not that batch subscription.
- Playground messages are loaded through `/api/eval-runs/playground/messages?threadId=...` with owner-scoped access.
- Abort checks can prevent later dispatches, but the current timeout/abort path does not guarantee that already-started remote work has terminated (K3).

Boot recovery marks stranded persisted Evaluation runs errored. Immutable admitted plans and reconnect snapshot reconciliation are still proposed shared-platform features.

### 3.3 Missing evaluator and deterministic-only cases

| Case definition | Current behavior when no evaluator is configured |
|---|---|
| Judge-only assertions | Configuration error before target execution |
| Mixed deterministic and Judge assertions | Execute deterministic checks; a deterministic failure can produce `failed`, while passed deterministic checks with unavailable Judge work produce `errored` |
| Pure deterministic assertions | Execute and judge in code without an evaluator |

Judge assertions not executed are represented without a numeric score and with an explanatory skipped/error state. The current reducer rejects missing, duplicate or unknown results rather than silently passing missing work. Broader error paths still need the result-identity cleanup in R1; do not assume every current transport already guarantees identical full rows.

There is no active suite-dimension preflight contract to add on top of these case assertions. The future `not_applicable` state is also not yet supported; it must not be inferred from today's `skipped` flag.

## 4. Current Scoring and Run Status

- Evaluated Judge items use integer **1–5**, with the suite threshold defaulting to **3**. Current suite API validation accepts a 1–5 threshold; the proposed 3–5 restriction is a future contract change.
- A case passes when its executed deterministic assertions and required judged assertions pass, subject to execution/configuration/Judge errors. The reducer preserves skipped/error state rather than inventing a low score for a failed Judge call.
- Deterministic pass/fail is not a 5/0 model quality grade. There is no active suite percentage-level decision system based on the old 80/60/40 bands; stale helpers or labels are tracked under D1/D2.
- Suite state is derived from case outcomes, not an averaged Judge score. UI counters such as "8/10 passed" describe case results, not an 80-point semantic grade.
- Current empty-assertion smoke semantics are separate from the proposed explicit `smoke_test` field in the new shared schema.

The proposed atomic score subsets, N/A handling, all-N/A outcome and calibrated dimensions are specified only in [Auto-Test Improvement §4.5](auto-test-improvement.md#45-integrated-evaluation-model-evidence-and-judge-service).

## 5. Current Evaluator Submission Tool

`submit_evaluation_scores` is assembled for programmatic evaluation and validated by [runtime-tools.ts](../src/lib/evaluation/runtime-tools.ts). Current arguments are:

- `item_scores`: `Array<{ index: number, score: number, reason: string }>`.
- `index`: non-negative integer matching the brief's sequential checklist items; callers currently remap these to assertion positions.
- `score`: integer 1–5.
- `reason`: non-empty evidence-based explanation.
- `feedback`: required non-empty overall summary.

The runtime scans Judge events backwards for a schema-valid submission. Structured parsing is deterministic; the quality of the model's explanation/grade is not. Index ambiguity and submission/rubric validation gaps remain tracked in J9/E11/J12. The new stable-ID/status/evidence-reference payload is a future replacement, not this tool's current API.

## 6. API Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/eval-suites/[id]/run` | Start an async suite run (202 + runId) |
| `POST` | `/api/eval-cases/[id]/run` | Inline playground case execution, without test-history rows |
| `GET` | `/api/eval-cases/[id]/latest-result` | Latest persisted result; case visibility checks apply |
| `GET` | `/api/eval-suites/[id]/runs` | Paginated history |
| `GET` | `/api/eval-runs/[id]` | Run detail and case results |
| `GET` | `/api/eval-runs/[id]/messages` | Case conversation replay |
| `GET` | `/api/eval-runs/playground/messages` | Owner-scoped playground replay |
| `POST` | `/api/eval-runs` with `agentId` | Agent-level batch execution |
| `GET/POST/PATCH/DELETE` | `/api/eval-suites/**`, `/api/eval-cases/**` | Definition CRUD |
| `GET` | `/api/eval-suites/agents` | Targets with suites for navigation |

Routes use the project's authentication/resource-permission helpers. Case deletion permits the case author, suite author or admin. Resource-binding and run-history authorization findings in the main plan remain relevant; this API inventory is not an authorization audit.

## 7. UI

The workspace uses an Agent/suite navigator, `EvalCaseList` and `EvalCaseInspector` with editable turns/assertions, verdict details and response replay.

- Suite execution shows progress/history through the suite editor and stream hook.
- Case playground output is held as a local result, separate from persisted test history.
- Text assertions expose response scope and optional turn number.
- Save handlers report failure and block a following Run. Atomic draft revisions, common result selection and reliable reconnect recovery are not yet implemented.
- Terminal busy state, result selection and shared capability gaps remain U1–U4 work in the main plan; no new metric editor is claimed here.

## 8. Shared Judge Dispatch and Configuration

Evaluation and Web Auto currently share [judge.server.ts](../src/lib/evaluation/judge.server.ts), while their brief construction and some score mapping remain separate.

| Setting | Default | Actual scope |
|---|---|---|
| `eval.step_timeout.evaluator` (`CONFIG_KEY_EVALUATOR_TIMEOUT`) | 300 seconds | Judge dispatch attempt timeout |
| `eval_suite.case_timeout_sec` | 300 seconds | Target execution timeout **per turn**, not one total conversation budget |
| `executeJudge.maxRetries` | 2 | Maximum dispatch attempts; values at or below zero return a skipped-evaluation error result |

`withStepTimeout` races the running promise against a timer; it does not itself terminate underlying work. Retry attempts can append the submission-tool warning. Diagnostics distinguish timeout, evaluator execution failure, missing submission, invalid JSON and schema-invalid arguments. Cancellation checks and timeout handling must not be advertised as confirmed upstream termination.

The future total Judge budget, isolated Judge purpose and immutable rubric contract belong to the unified refactor, not to the current defaults above.

## 9. Key Implementation Files

| File | Purpose |
|---|---|
| `src/lib/assertions/types.ts` | Shared assertion schemas and supported category capabilities |
| `src/lib/assertions/evaluator.server.ts` | Deterministic assertions |
| `src/lib/assertions/verdict-engine.server.ts` | Current shared case verdict reduction |
| `src/lib/evaluation/types.ts` | Current eight dimension rubrics and Evaluation types |
| `src/lib/evaluation/config.ts` | Timeout/threshold configuration and remaining legacy helpers |
| `src/lib/evaluation/judge.server.ts` | Shared Judge dispatch, timeout and extraction |
| `src/lib/evaluation/runtime-tools.ts` | Current score submission schema/tool |
| `src/lib/evaluation/deterministic-checks.ts` | Evaluation adapter for shared assertions |
| `src/lib/evaluation/prompt-builder.ts` | Current Judge brief |
| `src/lib/evaluation/eval-runner.ts` | Single-case execution |
| `src/lib/evaluation/run-orchestrator.ts` | Suite and Agent batch execution |
| `src/lib/evaluation/recovery.ts` | Boot recovery |
| `src/lib/evaluation/storage.ts` | Current module-local tables/repository |
| `src/lib/evaluation/access.ts` | Resource access helpers |
| `src/hooks/useEvaluationRunStream.ts` | Batch progress observation |
| `src/components/main-panels/evaluation/` | Current subsystem UI |

## 10. Unified Refactor Reference

The full improvement proposal formerly maintained here has moved, with its inconsistencies reviewed rather than copied unchanged:

- [Metric model, six dimensions, anchors, evidence and Judge contract](auto-test-improvement.md#45-integrated-evaluation-model-evidence-and-judge-service).
- [Shared database and immutable metric provenance](auto-test-improvement.md#47-database-consolidation-and-migration-design).
- [One priority, dependency and implementation plan](auto-test-improvement.md#5-one-prioritized-implementation-and-release-plan).
- [Combined contract, integration and Judge-calibration acceptance](auto-test-improvement.md#6-verification-and-acceptance-matrix).

Do not maintain a second dimension list for the target design, rollout table or future-feature backlog here. Update this runtime reference when the corresponding implementation actually ships.
