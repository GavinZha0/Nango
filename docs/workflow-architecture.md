# Workflow Architecture — Decision Log

> ✅ **CONCLUDED.** Workflow V1 is built. This file no longer
> describes the running system — read [`workflow.md`](./workflow.md)
> for that. What remains here is the decision log (D1 → D38, plus
> what was considered and rejected) and the open backlog.
>
> No new architectural discussion lands in this doc. New decisions
> go into `workflow.md` §7 (open questions) → §8 (status). When
> §7's chart-data-flow question is resolved, the resulting D-numbered
> decision gets appended to §2 below.

---

## 1. Status

- **Engine + save-as-workflow + refresh**: shipped (W1.x, W2, D4a).
- **Embedded run visualization**: partial — backend forensics ✅,
  `/admin/run` UI ❌ (D4b backlog).
- **Stage 2 modify pipeline**: designed (D5, §10 of the historical
  long-form), not built.
- **Chart data flow on refresh**: undecided — see `workflow.md` §7
  for routes A / B / C. Every refresh-button / scheduled-refresh /
  L2-cache item in §4 below depends on this.

This subsystem is paused pending §7's resolution. The codebase is
in a coherent state: GET/POST artifact endpoints work, refresh
re-runs the workflow and records to `entity_run`, the frontend just
doesn't yet consume the fresh `bundle.data`.

---

## 2. Decisions (D1 → D38)

Compact one-liners. Each decision is in effect unless marked
SUPERSEDED. Cross-reference `workflow.md` for current behaviour;
this log answers "why", not "what".

### Foundation (D1 – D17)

- **D1** Two-stage authoring: chat-time capture (Stage 1) + agent-modify (Stage 2). Stage 2 is designed-but-unbuilt.
- **D2** Refs stored as `@path` strings; TipTap is UI-only. (Walked back from "TipTap JSON as canonical storage".)
- **D3** Per-node `outputs[]` / `output_schema` are engine-derivable; LLM doesn't have to emit them.
- **D4** Engine fills the canonical `type` discriminator from the LLM-emit shape.
- **D5** Authoring tools `get_workflow` / `modify_workflow` / `modify_artifact_display` replace the retired `build_workflow_and_run` design.
- **D6** 3 LLM-facing buckets at design time (Tool / Agent / Control-flow); `frontend_tool` is NOT a workflow node — UI lives in `artifact.content`.
- **D7** Per-node `description` is REQUIRED.
- **D8** Artifact ↔ workflow is **1:N** — many artifact UI variants can share one workflow.
- **D9** Save = lazy capture from the run's tool chain, NOT eager spec emission during chat.
- **D10** Structured `WorkflowError` envelope + closed `WorkflowErrorCode` enum + per-code hint templates.
- **D11** No standalone `/workflow/<id>` editor page in V1. Visualization is embedded in the artifact detail; edits go through chat.
- **D12** ~~`workflow.source = 'agent_generated'`~~ **SUPERSEDED by D26** — `source` column dropped entirely.
- **D13** Agent node uses `<sourceLabel>/<agentName>` display label, mirrors `delegate_to_agent`. Resolved to UUID at save (D27).
- **D14** Save-time ref reconstruction: regex whitelist + length filter + lineage report + engine `REF_UNRESOLVED` hard error. Tag `ref_recon_v1`. (Refined by D33.)
- **D15** Data engine ↔ UI engine architectural separation. Workflow is data; artifact carries the UI snapshot. They meet via FK only.
- **D16** Agent nodes invoked from a workflow have `frontend_tool` filtered out of their tool list.
- **D17** Workflows engine lives in `src/lib/workflows/`; the runner ↔ workflows cycle is broken by DI — engine declares a `WorkflowEngineDependencies` interface, the artifact-side adapter (`execute-workflow.ts`) injects concrete implementations.

### Save + execute (D18 – D24)

- **D18** Save-as-workflow is **fully deterministic — zero LLM** at save time.
- **D19** 3-tier `outputSchema` source priority: declared > observed > inferred.
- **D20** Per-node content-addressable cache (Plan C). Class implemented in `engine/cache.ts`, **not wired** to the executor.
- **D21** V1 agent-node eligibility narrowed: excludes supervisor agents and agents bound to `frontend_tool`. Filter mechanism intentionally deferred.
- **D22** "Workflow" is two flavours in Nango: local DAG (this codebase) + backend workflow (agno/Dify/Mastra). Both share `entity_run` with `entityKind='workflow'`; `entitySource` is the dispatcher discriminator. Local-only mechanics gate on `entitySource='builtin'`.
- **D23** Condition node + dynamic edges + SKIP convergence deferred to V1.1. V1 spec-validate rejects `condition` nodes with `SPEC_FEATURE_UNSUPPORTED`. Saves 5-7 days off M1.
- **D24** `entity_run` adds **zero** new columns for workflows. Polymorphic `entityId` carries `workflow.id`. Per-node outputs + suspend state live in `entity_run_event` (events as source of truth). `SaveLineageReport` persists as a `save_lineage_emitted` event.

### Schema final cut (D25 – D30)

- **D25** Suspend/Resume + `snapshot.ts` deferred to V1.1. No V1 workflow needs it. Engine throws `SPEC_FEATURE_UNSUPPORTED` if a node calls `suspend()`. Boot recovery marks stranded workflow runs as failed.
- **D26** Workflow schema final cut: drop `workflow.source`, drop `is_published`, drop `workflow_dependency` table (info already in `spec` — query via JSONB+GIN). Table goes 9 → 7 columns. Permissions become ownership + visibility only.
- **D27** `NodeType` enum + identifier alignment. `tool` field is the literal `toolName` from the LLM tool call record. Agent nodes carry **both** `agent: "<src>/<name>"` (label, may drift) and `agentId: <uuid>` (one-shot EntityCatalog resolution at save). Runtime dispatches by `agentId`.
- **D28** Workflow outputs are a top-level `spec.outputs: Record<key, RefString>` declaration, NOT a node. The previous `type: 'output'` node is retired. `NodeType` reduces to **2 V1 values** at this point: `'tool'` / `'agent'`. Error codes `SPEC_NO_OUTPUTS` / `OUTPUT_REF_UNRESOLVED` replace the per-node-output equivalents.
- **D29** Spec node ids are **numeric** (`id: number`, `depends_on: number[]`, refs `@nodes.<num>.<field>`). Eliminates sanitize/slug/collision code. Modify-workflow keeps existing ids; new nodes get the next available number, no renumbering.
- **D30** Save pipeline captures agent invocations with the default `output_schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] }`. Refresh runtime wraps the agent's reply as `{ text: ... }`. Richer schemas come from Stage 2 modify, V1.1+ may infer.

### Surface + integration (D31 – D34)

- **D31** Artifact-shaped API surface. Endpoints are `/api/artifacts/[id]` + `/api/artifacts/[id]/refresh` — no `/api/workflows` CRUD is exposed (D24 says workflow has no first-class HTTP surface).
- **D32** Chat and workflow share **one** user tool catalog. Workflow execution and chat dispatch both pull `ToolDefinition` from the same catalog factory; no per-subsystem registry duplication.
- **D33** Save-pipeline lineage refinement: Strategy Z+ recurses through array args (W1.7.5–W1.7.6); sandbox `ok/data/error` envelope is unwrapped before ref reconstruction. Fixes the first end-to-end `OUTPUT_REF_UNRESOLVED` failures on real chats.
- **D34** Dataset content-addressing **deferred** to V1.x. Slot-reassignment (last-write-wins on same dataset name) retired half the motivation; physical dedup across different names → identical query still pending.

### Sandbox / SQL promotion (D35 – D38)

- **D35** Explicit `type` discriminator + first-class **code node**. Sandbox Python execution stops being a generic tool node (`tool: "run_code_in_sandbox"`) and becomes `type: "code"` with its own variant, default outputs `{ stdout, stderr, exitCode, durationMs }`, and a custom `output_schema` path (D35.B) that parses JSON from stdout.
- **D36** First-class **SQL node**. `extract_dataset_by_sql` invocations become `type: "sql"` with `{ dataSourceName, query, name }` and outputs `{ name, rowCount }`. The dataset slug becomes the canonical handle for downstream code nodes.
- **D37** SQL node `name` is a **slot** (last-write-wins). Re-running with the same name + a different query replaces the cached dataset; no `QUERY_HASH_MISMATCH`. The tool description teaches the LLM "name is a slot, not a content hash". Structured log event: `dataset_replaced`. (See `data-sources.md` §4.2.)
- **D38** Sandbox path contract redesign. Datasets mount at `./data/<name>/data.parquet` relative to the sandbox cwd — no more `/mnt/cache` magic paths. Sweep on Node boot via `purgeAllDatasets()` (cache lifetime = process lifetime). Module-level caches pinned to `globalThis` for HMR safety (C1).

### Pinned implementation corrections

- **Correction 1**: `modify_artifact_display` lives in `src/lib/artifacts/` (NOT `src/lib/workflows/`).
- **Correction 2**: save trigger is the OUTCOMES page (NOT the artifact page).
- **C2**: dead `createArtifact` / `findCategoryFolderId` removed; W1.7.7 retired.

### Operational decisions (D4a / W2)

- **D4a** Workflow refresh forensics. Only `forceFresh: true` writes to DB. `startRecording({ workflowId, ownerId, workflowName? })` returns `{ runId, emit, succeed, fail }`. The `EntityRunEventType` union grows three workflow-specific types (`workflow_node_attempt_started` / `_failed` / `workflow_node_completed`). No DB migration — the column is text.
- **W2** Refresh-path agent dispatch is real. `buildRealRunAgent(ownerId)` replaces `stubRunAgent` when `forceFresh: true`. Each agent sub-run gets its own `entity_run` row with `parent_run_id` = workflow run. The GET path keeps the stub so reads remain side-effect-free.

---

## 3. Considered and not adopted

| Pattern | Why not (V1) | Revisit if |
|---|---|---|
| **TipTap mention JSON as canonical storage** | Couples spec to a UI library; breaks server-side validators; non-JS clients can't author. (D2) | Never. |
| **Normalised 3-table workflow schema** | Single JSON spec gives hash-based caching cheaply; a 3-table layout would force JOINs in the hot path. | Never (V1). |
| **TS-builder DSL** (Mastra-style) | We are JSON-first for non-developer users; the LLM emits JSON, not code. | If a "workflows as code" surface for SDK consumers becomes a goal. |
| **`condition` node + dynamic edges** | Save-from-chat doesn't surface them; Stage 2 modify can ask for them when it ships. (D23) | V1.1, after `modify_workflow` lands. |
| **Nested `workflow` node** | DAG composition adds cache-key complexity, scope rules, and recursive limit-enforcement. (D6) | V2. |
| **Suspend/resume + snapshot persistence** | V1 audit found no workflow that actually pauses. (D25) | When polling-style nodes ship (webhook wait, human approval). |
| **Cron multi-instance scheduler** | Nango is single-node; the `setTimeout` scheduler fits. | Never as long as the runtime boundary holds. |
| **`source = 'agent_generated'` column** | Only one V1 authoring path; column carried no information. (D26) | Re-add purely additively when builtin workflows ship. |
| **LLM as a direct node type** | Goes through `builtin_agent`; keeps tool/agent boundary clean. | Never. |
| **`build_workflow_and_run` tool** | Replaced by the lazy two-stage authoring model. (D5) | Never. |
| **`workflowOutputs` per-node declaration** | Superseded by top-level `spec.outputs` (D28). | Never. |
| **`type: 'output'` sink node** | Superseded by `spec.outputs` (D28). | Never. |

---

## 4. Backlog (paused)

Items are listed in priority order within each tier. None is being
worked. The **blocked** items in §4.0 will not start until the §7
decision in `workflow.md` is made.

### 4.0 Blocked on chart data flow architecture (workflow.md §7)

- **Refresh button + chart data binding** (V1.x).
  Routes A (render_chart-as-node) / B (template + data binding) /
  C (regenerate-via-chat) documented; no choice made.
- **Scheduled refresh** (cron-style "refresh this artifact weekly").
  `schedule` table exists; no `entityKind='workflow'` dispatch path —
  not meaningful until refresh shows the user something.
- **L2 workflow-output cache** (`forceFresh: true` actually does
  something). Currently a no-op.

### 4.1 Unblocked V1.x polish

- **W1.8.5** — code-block syntax highlighting in the workflow graph
  preview (`rehype-highlight`).
- **Per-node execution metadata channel** — sidecar reader →
  `nodeMeta` plumbed to the UI per-node panel.
- **Code-node description** — change `'stdin=...'` → `'language:
  code preview'` (cosmetic; aligns with D35).
- **D4b** `/admin/run` UI — list + detail page. Backend API
  (`/api/admin/runs/[id]`) is shipped (D4a); only the frontend
  page is missing.

### 4.2 Sandbox follow-ups (not prioritised)

- **A1** Sandbox-output artifact harvest — when a code node produces
  a usable artifact (CSV, image), surface it back as an attachable.
- **A2** `docs/sandbox.md` pyarrow / py3.13 setup note.
- **A3** Subprocess pre-flight check (python3 version, pyarrow
  importability) on sandbox boot.

### 4.3 Designed-but-not-built (V1.x)

- **`modify_workflow` agent tool** — chat-driven spec edits. Reads
  spec via `get_workflow`, agent emits a patched LLM-emit version,
  server re-canonicalises and writes back.
- **`get_workflow` agent tool** — bound counterpart for the above.
- **Workflow visibility = `public` sharing UX** — flag exists in
  schema; no UI surface.

### 4.4 V2 / out of scope

- LLM-from-scratch authored workflows (V1 LLM only captures + modifies).
- Multi-tenant workflow marketplace / forking.
- Workflow versioning history (`updatedAt` is the only checkpoint).
- Streaming workflow output to the artifact page during execution
  (would need SSE for refresh runs).
- Cross-thread workflow reuse from chat (saved workflow as an
  on-demand tool).

---

## 5. Reference materials (study targets, not import targets)

Patterns borrowed from prior art. Source paths are repo-root-relative
to each project.

| Reference | What we borrowed | What we rejected |
|---|---|---|
| **Mastra** `packages/core/src/workflows/` | Abstract `ExecutionEngine` base · suspend/resume primitives (V1.1) · snapshot-per-step (V1.1) · per-step retries · `AbortSignal` plumbing · input/output/state schemas per step | TS-builder DSL · structured-flow replacing DAG · cron multi-instance scheduler · `bail` / `tripwire` / time-travel |
| **ChatPie** `src/lib/ai/workflow/` | TipTap @mention as editor *rendering* layer · `condition` DSL (V1.1) · explicit output sink (later refactored to `spec.outputs`) · DFS cycle detection (V2) · workflow-as-agent-tool surface | Normalised 3-table schema · `ts-edge` dependency · no run persistence · LLM as direct node type · **TipTap mention JSON as canonical storage** (walked back, D2) |
| **Open Multi-Agent** | Coordinator pattern → LLM emits structured task DAG · `parseTaskSpecs` graceful fallback · "prefer fewer dependencies" prompt bias · column-by-level DAG layout (~100 LoC, used by the embedded run viz) | Untyped tasks · SharedMemory as data-passing · one-shot execution without persistence · agent-name-only `assignee` |

Broader prior art surveyed for product-layout vocabulary but not
read at source level: Dify, Coze, n8n, Argo, Airflow, Dagster, Hex,
Temporal, Retool Workflows.

---

## 6. Reading list

- [`workflow.md`](./workflow.md) — current canonical reference (what is built).
- [`data-visualization.md`](./data-visualization.md) — outcomes panel + chart UI.
- [`data-sources.md`](./data-sources.md) — Parquet cache, slot semantics, `extract_dataset_by_sql`.
- [`sandbox.md`](./sandbox.md) — D35 / D38 path contract.
- [`runner-events.md`](./runner-events.md) — AG-UI ↔ `EntityRunEventType` mapping.
- [`orchestrator.md`](./orchestrator.md) — runner kernel; dispatch model.
- [`artifact-evolution.md`](./artifact-evolution.md) — V2 artifact library plans.
- [`architecture.md`](./architecture.md) — whole-product layered architecture.

---

*This page used to be a 6 000-line pre-implementation design log.
The full prose was retired on the same commit that introduced this
condensed form — the git history of this file is the long-form
archive. Subsequent decisions live in `workflow.md` §7 → §8.*
