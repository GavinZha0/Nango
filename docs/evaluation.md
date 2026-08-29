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

## 2. Three-Layer Evaluation Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Baseline (3 criteria — always evaluated)                │
│  Task Completion · Safety & Compliance · Fluency         │
├─────────────────────────────────────────────────────────┤
│  Suite Dimensions (0–5 selectable — suite-level)         │
│  faithfulness · tool-correctness · format-compliance     │
│  code-accuracy · tone-persona                            │
├─────────────────────────────────────────────────────────┤
│  Case Criteria (per-case — LLM + deterministic + metrics)│
│  expectation · assertions · keywords · tool_calls        │
│  max_duration_s · max_output_tokens · max_tool_calls     │
└─────────────────────────────────────────────────────────┘
```

**Baseline** — baked into the evaluator's system prompt. Three
sub-criteria with scoring rubrics (0–100). Uses strict-bias policy
and a min-cap rule.

**Dimensions** — 5 builtin specialized dimensions, each with a full
evaluation prompt (OBJECTIVE → STEPS → RULES → RUBRIC). Designed
following DeepEval/RAGAS best practices: chain-of-thought, strict
bias, 5-level anchored rubric. Suite-level selection only.

**Criteria** — per-case JSON with 11 fields in 3 categories.
Validated by Zod (`.strict()`). LLM-evaluated fields are sent to
the evaluator; deterministic fields are verified by code;
execution metrics are measured by the runner.

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
    │     keywords · tool_calls · execution metrics
    │     Output: per-item pass/fail + pass_rate
    │
    ├─ ③ Assemble evaluator prompt
    │     baseline + dimension prompts + criteria context
    │     + deterministic results + conversation text
    │
    ├─ ④ Dispatch evaluator agent
    │     Calls submit_evaluation_scores tool once
    │     Returns: baseline_score + dimension_scores
    │     + criteria_score + feedback
    │
    ├─ ⑤ Compute final criteria score
    │     = evaluator criteria_score × deterministic pass_rate
    │
    ├─ ⑥ Write eval_case_result + publish SSE
    │
    └─ (next case)

Finalize: aggregate passed/failed/errored counts → eval_run
```

### 3.2 Single Case Run (Synchronous Playground Mode)
- **Zero DB pollution**: `POST /api/eval-cases/[id]/run` executes the 6-step pipeline synchronously inline without persisting `eval_run` or `eval_case_result` records (mirrors Verification & Web Auto).
- **Direct UI Feedback**: Returns `RunEvalCaseResult` JSON directly (200 OK) to populate the case inspector outcome state.
- **Thread Replay**: Ephemeral conversation messages are retrieved on-demand via `/api/eval-runs/playground/messages?threadId=...` bounded by session owner authentication.

Recovery: stranded `eval_run` rows (`status='running'`) are swept
to `errored` on boot via `instrumentation.ts`.

---

## 4. Scoring & Levels

**Case-level** — overall score aggregates baseline + dimensions +
criteria (weighted average). Pass/fail determined by configurable
threshold.

**Suite-level** — pass/fail ratio, not numeric average. Status is
`passed` (all cases pass), `failed` (any fails), or `errored`
(any runner error). UI shows `8/10 Passed (2 Failed)`.

**4 evaluation levels** with configurable thresholds
(DB keys `eval.threshold.*`):

| Level | Default | Color |
|---|---|---|
| Excellent | ≥ 80 | Blue |
| Pass | ≥ 60 | Green |
| Poor | ≥ 40 | Amber |
| Fail | < 40 | Red |

---

## 5. Evaluator Tool

`submit_evaluation_scores` — server tool injected into evaluator
agents during programmatic dispatch. Tool calls are natively
structured (Zod-validated JSON args), making score extraction
deterministic vs. parsing free text.

Accepts: `baseline_score`, `dimension_scores[]` (with per-dimension
justification), `criteria_score`, `feedback`. Validates expected
dimension IDs; rejects unknown or missing dimensions.

---

## 6. API Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/eval-suites/[id]/run` | Start async suite run (202 + runId) |
| `POST` | `/api/eval-cases/[id]/run` | Synchronous playground single case run (200, no DB writes) |
| `GET` | `/api/eval-suites/[id]/runs` | Paginated run history |
| `GET` | `/api/eval-runs/[id]` | Run detail + case results |
| `GET` | `/api/eval-runs/[id]/messages` | Conversation replay for a case |
| `GET/POST/PATCH/DELETE` | `/api/eval-suites/**`, `/api/eval-cases/**` | Suite + case CRUD |
| `GET` | `/api/eval-suites/agents` | Agents with eval suites (left panel) |

All routes wrapped by `withEditor` and protected by `canEditResource` / `canViewResource` RBAC checks.

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

## 8. Key Files

| File | Purpose |
|---|---|
| `lib/evaluation/types.ts` | Dimensions, criteria schema, level config, shared types |
| `lib/evaluation/config.ts` | Scoring thresholds, level system |
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
- **Batch agent runs** — "Run all suites" from the left panel.
- **Score trending** — per-case score history chart across runs.
- **Schedule-driven evaluation** — hook suites into the scheduler.
- **Full RecentRunsBanner** — paginated run history per suite with
  detailed breakdown.
