# Evaluation Subsystem

> **Status**: Stage 1 — schema, CRUD, and editor UI are shipped.
> **Next (Stage 2)**: The run executor (agent dispatch + evaluator scoring).
> This involves wiring up the `Run` API endpoints, executing the target agent,
> dispatching the evaluator agent, parsing scores, and persisting results to `eval_case_result`.

**Position in the product**: a *stochastic* LLM-as-Judge quality
assessment framework for agent conversations. Complementary to the
**Verification** subsystem (`docs/verification.md`) which is
deterministic assert-on-output.

---

## 1. Core Concepts

An **Eval Suite** groups test cases that target one agent (builtin or
backend). Each suite selects an **Evaluator Agent** (`role='evaluator'`)
and a set of **Evaluation Dimensions** whose prompts are injected at
scoring time.

An **Eval Case** is a multi-turn conversation script (`turns[]`) plus
case-level **Criteria** — a hybrid object containing both LLM-evaluated
fields (issue, expected outcome, reference, context) and deterministic
checks (tool calls, keywords, assertions).

A **Run** executes the target agent against the conversation script,
then dispatches the evaluator agent to score each dimension 0–100.

---

## 2. Data Model

Five tables. Migration: `0005_eval-tables.sql`.

### 2.1 Definition Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `eval_suite` | Case collection targeting one agent. | `agent_id`, `agent_source`, `credential_id`, `evaluator_agent_id`, `dimension_ids[]` |
| `eval_case` | Multi-turn test case within a suite. | `suite_id`, `turns[]`, `criteria{}`, `dimension_override[]` |

**Polymorphic agent identity**: `(agent_id, agent_source, credential_id)`.
`agent_source = "builtin"` → `agent_id` is a `builtin_agent.id` UUID;
`agent_source = "backend"` → `agent_id` is a platform entity ID,
`credential_id` required.

### 2.2 Runtime Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `eval_agent_run` | Agent-level batch execution. | `agent_id`, `status`, `score`, pass/fail/error counts |
| `eval_run` | Suite-level execution (optionally within an agent batch). | `suite_id`, `agent_run_id?`, `status`, `score` |
| `eval_case_result` | Per-case scoring result. Composite PK `(run_id, case_id)`. | `score`, `dimension_scores{}`, `feedback`, `thread_id`, `evaluator_thread_id` |

`thread_id` links to the target agent's `entity_run` records;
`evaluator_thread_id` links to the evaluator agent's scoring session.

---

## 3. Evaluation Dimensions

5 builtin specialized dimensions across 4 categories, defined as code constants
in `lib/evaluation/types.ts` (`BUILTIN_DIMENSIONS`). The foundational criteria (Task Completion, Safety, Fluency) are baked into the `DEFAULT_EVALUATOR_SYSTEM_PROMPT` universal baseline, while these specialized dimensions are injected dynamically.

| Category | Dimensions |
|---|---|
| Knowledge & RAG | faithfulness |
| Agent & Execution | tool-correctness |
| Formatting & Output | format-compliance, code-accuracy |
| Persona & Style | tone-persona |

Suite-level dimension selection; per-case override via `dimension_override`.

---

## 4. Criteria

`eval_case.criteria` is a JSON object (`EvalCriteria`) with two
evaluation paths:

**LLM-evaluated** (sent to the evaluator agent):

| Field | Purpose |
|---|---|
| `issue` | User-reported problem observed during conversation. |
| `expectation` | Natural language description of correct behavior. |
| `reference` | Ground truth / reference answer. |
| `context[]` | Supplementary business rules or knowledge snippets. |

**Deterministic** (verified by code, results fed to evaluator):

| Field | Purpose |
|---|---|
| `tool_calls[]` | Tool names that should be called. |
| `expected_keywords[]` | Keywords that must appear in the response. |
| `unexpected_keywords[]` | Keywords that must NOT appear. |
| `assertions[]` | Expression-style checks (e.g. `"duration_ms <= 5000"`). |

Runtime validation: `evalCriteriaSchema` (Zod, `.passthrough()` for
forward compatibility).

---

## 5. Evaluator Agent

The evaluator is a system role on `builtin_agent` (`role = 'evaluator'`).

- Multiple evaluators allowed per user (no uniqueness constraint).
- Monotonic role assignment — once set, irreversible.
- Filtered from chat picker, handoff targets, and supervisor catalog.
- Selected per-suite via `evaluator_agent_id` (FK, `SET NULL` on delete).

---

## 6. Execution Flow (Stage 2 — not yet implemented)

```
User clicks "Run Suite"
    │
    ▼
Create eval_run (status = "running")
    │
    ├─ For each enabled case:
    │   ├─ Execute target agent with turns → capture response
    │   ├─ Deterministic checks (keywords, tool_calls, assertions)
    │   ├─ Dispatch evaluator agent
    │   │   └─ Input: agent response + criteria + dimensions
    │   │   └─ Output: per-dimension scores 0–100 + feedback
    │   └─ Write eval_case_result
    │
    ├─ Aggregate suite-level score
    └─ Publish SSE updates → UI refreshes
```

Recovery: `eval_run_recovery_idx` partial index on `status = 'running'`
enables boot-time sweep of stranded runs.

---

## 7. API Routes

All routes wrapped by `withEditor`. Eval suites are **private by
design** — scoped to creator (admin sees all).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/eval-suites?agentId=&agentSource=` | List suites with case counts. |
| `POST` | `/api/eval-suites` | Create suite. |
| `GET` | `/api/eval-suites/[id]` | Suite detail + case count. |
| `PATCH` | `/api/eval-suites/[id]` | Update suite metadata. |
| `DELETE` | `/api/eval-suites/[id]` | Cascade delete. |
| `GET` | `/api/eval-suites/[id]/cases` | List cases. |
| `POST` | `/api/eval-suites/[id]/cases` | Create case. |
| `PATCH` | `/api/eval-cases/[id]` | Update case. |
| `DELETE` | `/api/eval-cases/[id]` | Delete case. |
| `GET` | `/api/eval-suites/agents` | Distinct agents with eval suites (left panel). |

DB access is centralized in `lib/evaluation/storage.ts`; route handlers
do not import `db` or schema tables directly.

---

## 8. UI

### 8.1 Left Panel (`EvaluationPanel`)

Two tabs: **Builtin** / **External**. Lists agents with eval suites,
showing suite counts. Actions: navigate, run all, delete all.

### 8.2 Routes

| Route | Target |
|---|---|
| `/evaluation` | Opens left panel (redirect). |
| `/evaluation/[id]` | Builtin agent editor. |
| `/evaluation/[credentialId]/[agentId]` | Backend agent editor. |

Both routes render `EvaluationEditor` — a thin orchestrator delegating
to sub-components in `components/main-panels/evaluation/`.

### 8.3 Editor Layout (3-pane)

```
┌──────────────┬──────────────────┬───────────────┐
│ EvalSuiteTree │ EvalCaseInspector │ Results       │
│ Suite + case  │ Conversation     │ Dimension     │
│ tree          │ + Criteria       │ score bars    │
│               │ + Save button    │               │
└──────────────┴──────────────────┴───────────────┘
```

- **EvalSuiteTree**: Collapsible suite headers with nested cases;
  edit / delete / run actions per suite.
- **EvalCaseInspector**: Multi-turn conversation editor (top half) +
  tabbed Criteria JSON editor / Response viewer (bottom half).
  Explicit Save button with dirty-state tracking; disabled when clean
  or when criteria JSON is invalid.
- **Results panel**: Per-dimension score bars (placeholder until
  executor lands).

### 8.4 Save from Chat (`SaveToEvalDialog`)

From the chat interface, users can save a conversation to evaluation.
The dialog captures `issue` (what went wrong) and `expected_outcome`
(expected behavior), parses the thread into `EvalTurn[]`, and creates
a case in an auto-generated "Drafts" suite.

---

## 9. State Management

Two Zustand stores:

| Store | Key | Contents |
|---|---|---|
| `useEvaluationStore` | `agentId:agentSource` | Agent list, suite cache |
| `useEvalCasesStore` | `suiteId` | Case cache per suite |

---

## 10. Permissions

| Action | Required role |
|---|---|
| All suite / case CRUD | `editor`+ |
| View suites | Creator or `admin` |
| Edit / delete suites | Creator or `admin` |

---

## 11. Key Files

| File | Purpose |
|---|---|
| `lib/evaluation/types.ts` | `EvalDimension`, `EvalCriteria`, `EvalTurn`, `evalCriteriaSchema` |
| `lib/evaluation/storage.ts` | Centralized DB access layer |
| `lib/evaluation/access.ts` | Permission-check helpers (`loadSuite`, `loadCase`) |
| `lib/db/migrations/0005_eval-tables.sql` | Schema migration |
| `store/evaluation.ts` | Suite store + actions |
| `store/evaluation-cases.ts` | Case store + actions |
| `components/main-panels/EvaluationEditor.tsx` | Main orchestrator |
| `components/main-panels/evaluation/` | Sub-components (tree, inspector, dialog) |
| `components/left-panels/EvaluationPanel.tsx` | Left sidebar panel |
| `components/chat/SaveToEvalDialog.tsx` | Chat → eval capture |

---

## 12. Future

- **Run executor**: Dispatch target agent, run deterministic checks,
  invoke evaluator agent, persist scores and feedback.
- **Evaluator prompt engineering**: Inject dimension definitions +
  criteria into the evaluator's system prompt; parse structured
  scoring output.
- **Run history & results UI**: Recent-runs banner, historical score
  display, feedback viewer.
- **Batch agent runs**: "Run all suites" for an agent from the left
  panel.
- **SSE live updates**: Reuse `/api/runs/stream` for real-time
  progress during suite execution.
- **Custom dimensions**: Allow users to define project-specific
  evaluation dimensions beyond the 12 builtins.
