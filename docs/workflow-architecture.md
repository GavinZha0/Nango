# Workflow Architecture — Decision Log

> ✅ **CONCLUDED.** Workflow V1 is built. This file no longer
> describes the running system — read [`workflow.md`](./workflow.md)
> for that. What remains here is the decision log (D1 → D39, plus
> what was considered and rejected) and the open backlog.
>
> No new architectural discussion lands in this doc. New decisions
> go into `workflow.md` §7 (open questions) → §8 (status). The
> chart-data-flow question raised in `workflow.md` §7 was resolved
> as **D39** (§2 below); refresh / data-binding / cache items
> previously blocked on it are now actionable.

---

## 1. Status

- **Engine + save-as-workflow + refresh**: shipped (W1.x, W2, D4a).
- **Embedded run visualization**: partial — backend forensics ✅,
  `/admin/run` UI ❌ (D4b backlog).
- **Stage 2 modify pipeline**: designed (D5, §10 of the historical
  long-form), not built.
- **Chart data flow on refresh**: ✅ **resolved as D39** (chart node
  promoted to a first-class workflow node, frontend renders from
  `bundle.data`). Implementation in progress.

This subsystem is back under active work. The clean-slate refactor
toward D39 explicitly **does not** preserve pre-refactor workflow /
artifact rows — old data is wiped, no migration code is written.

---

## 2. Decisions (D1 → D39)

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

### Chart refactor (D39)

- **D39** Chart refactor — supersedes `workflow.md` §7 (routes A / B / C). Resolves the "chart data flow on refresh" question. Four sub-points:
  - **D39.A** **Chart-as-node.** The chat-time chart tool (renamed from `render_chart` to `generate_echarts_config`, see D39.E) is no longer stripped at save; it is reconstructed as a first-class `type: "chart"` workflow node. The node stores an ECharts option **template** (no data) under `inputs.config` and a `@path` ref to upstream data under `inputs.dataset`. At execute time the engine merges them and returns `{ option }` — rendering still happens in the browser. Decouples the **data engine** (DAG produces data) from the **renderer** (browser draws); workflow becomes self-contained for refresh. Picks Route A from §7.2, but explicitly **NOT** server-side rendering — only server-side config storage.
  - **D39.B** **Single injection point.** Chart node v1 supports only `option.dataset.source` as the data-binding target (ECharts dataset API). `series[*].data` literals are NOT auto-reconstructed into refs — keeps the LLM contract narrow and the validator straightforward. Charts that don't fit fall back to D39.C. Future `chart:2` may extend.
  - **D39.C** **Literal fallback on reconstruction miss.** When `build-from-events` Strategy Z+ cannot match a `generate_echarts_config` call's data points to any upstream tool output, the chart is still saved — but as a `chart` node with literal `config` (data baked in) and empty `inputs.dataset`. UI surfaces "not refreshable" indicator. Hybrid of "save anyway" + "be honest about it".
  - **D39.D** **`artifact.content.blocks` retired.** The field had two consumers — chart option snapshot (now in `workflow.spec`'s chart node) and pre-refactor static save. Both are gone after D39.A. Drop the column in Phase 5 of the refactor (when frontend stops reading it); not Phase 0, because today's `ArtifactDetail` still reads it.
  - **D39.E** **Rename `render_chart` (frontend tool) → `generate_echarts_config` (server tool).** Three benefits stack: (1) **uniformity** — `render_chart` was Nango's only significant frontend tool; promoting it to a server tool eliminates the entire "frontend tool" special case from the dispatch / build-from-events / agent-tool-filter paths. (2) **AG-UI run lifecycle** — frontend tool calls interrupt the current AG-UI `run` and start a new one (CopilotKit convention); server tools complete within the same run, removing one source of stream disruption. (3) **Symmetric naming for future libraries** — `generate_<lib>_config` becomes the convention; `build-from-events` derives the chart node's `inputs.renderer` value from the tool-name suffix (`_echarts_config` → `"echarts"`, future `_plotly_config` → `"plotly"`). The frontend `useRenderTool` continues to provide streaming-arg preview unchanged; a frontend side-effect hook handles the post-result Outcomes-store update that used to live in the frontend handler.

  No backward-compat migration: pre-D39 `workflow` / `artifact` rows are wiped at refactor start; users re-save charts. The `render_chart` frontend tool registration is fully removed in Phase 1.

  **D39 cross-cutting structural sub-conclusions** (binding for the entire refactor; see `workflow-spec.md` for prescriptive form):

  - **8 universal top-level fields per node** (`id`, `type`, `schema_version`, `description`, `depends_on`, `inputs`, `input_schema`, `output_schema`) plus 2 optional (`retries`, `timeout_seconds`). All type-specific parameters (tool name, language, SQL text, renderer, …) live one level down inside `inputs`. No third location.
  - **`inputs` ↔ `outputs` naming symmetry**: `inputs` is the **static parameter bag in spec** (may contain `@path` refs); `outputs` is the **runtime output bag in `entity_run_event`** payloads. The spec no longer carries an `outputs[]` field-name array — recoverable from `output_schema.properties`.
  - **snake_case for all spec keys** (`data_source_id`, `total_rows`, `agent_id`, `timeout_seconds`, …). The pre-refactor mix of camel + snake is retired.
  - **`input_schema` and `output_schema` are both canonical-required**, always filled by `canonicalize` from per-type rules (registry for tool, constants for sql/chart, LLM-emit for agent/code).
  - **Tool node aligns with OpenAI / MCP standard**: `inputs = { name, arguments }`. `name` is `const`-pinned in canonical `input_schema`. Promoted tools (`generate_echarts_config`, `run_code_in_sandbox`, `extract_dataset_by_sql`) are rejected as `type: "tool"` and must use their dedicated node types.
  - **SQL node**: inputs = `{ data_source_id, sql_text, dataset_id? }`; runtime outputs = `{ dataset_id, total_rows, returned_rows, rows, row_schema }`. No `return_mode` field — engine policy via two config keys (`sql.inline_max_rows` default 100000, `sql.inline_max_bytes_mb` default 20). `returned_rows` is exposed as a number so the LLM doesn't have to count rows (LLMs miscount arrays at scale). `row_schema` is populated even for 0-row results.
  - **Code node**: inputs = `{ language, code_text|code_file, datasets?, params? }`; `code_text` XOR `code_file` (validator-enforced); v1 languages `python` + `javascript`; JS rejected if `datasets` is non-empty (no parquet reader); default output `{ stdout, stderr, exit_code, duration_ms }` snake_case; LLM MAY override with custom `output_schema` that merges into the default as non-required additions.
  - **Agent node**: inputs = `{ name, task, context? }` — flat fields; no `args` wrapper; output is canonical-fixed `{ result: string }`. **This supersedes D30** (LLM no longer writes `output_schema`). Only `role IS NULL` agents are eligible; supervisor / secretary / evaluator rejected with `AGENT_ROLE_NOT_ROUTABLE`. String-interpolation refs not supported in v1.
  - **Chart node is static**: chart node holds a config template (no data) + a `@path` ref to upstream rows; engine merges at execute time. The chart node is NOT a dynamic agent — no LLM call at execute time. Two LLM-authoring contexts coexist: chat-time `generate_echarts_config` (server tool post-D39.E, writes data inline for immediate render) and modify-time `modify_workflow` (server tool, writes the template form). `build-from-events` bridges chat-time → template at save. Rationale: cost (every refresh = LLM call would be expensive), determinism (saved chart should look the same across refreshes), industry precedent (all mature BI tools ship static-config + dynamic-data), and the "LLM lacks data" worry is moot — chat-time LLM has SQL preview in context.

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

## 4. Backlog

Items are listed in priority order within each tier.

### 4.0 D39 chart refactor (landed)

Chart-as-node is end-to-end live: chat-saved charts become
first-class `type: "chart"` workflow nodes, refresh re-executes
the bound workflow, and the artifact page renders from the
resolved option. See `docs/D39-implementation-log.md` for the
phase-by-phase commit map and the "shipped vs prescriptive"
delta against the rest of this spec.

- ✅ **snake_case spec keys + per-node `schema_version` stamping** (Phase 1.0).
- ✅ **Chart node Zod schema + canonicalize + validate + executor + engine dispatch** (Phase 1.1).
- ✅ **`build-from-events` reconstructs chart nodes** with Strategy Z+ array matching + D39.C literal fallback (Phase 1.4).
- ✅ **SQL node exposes `rows` so chart refs can validate** (Phase 1.4-A).
- ✅ **Frontend renders from `bundle.data`** (`<EChartsRenderer option={bundle.data}>` in `ArtifactDetail`) (Phase 1.5).
- ✅ **Refresh button + UX** — POST refresh → SWR mutate (Phase 1.6).
- ✅ **`artifact.content` column dropped** (Phase 5, D39.D).

Still on the backlog (deferred — not on the chart-refactor
critical path):

- **L2 workflow-output cache** — only if profiling demands; the
  current GET → executeWorkflow round-trip is cheap in single-node
  setups.
- **Scheduled refresh** (`entityKind='workflow'` dispatch path).
  Reachable now that the synchronous refresh works end-to-end.
- **Other artifact types as workflow nodes** — `render_html` /
  `render_markdown` still take the legacy strip-to-content path
  (the column is gone but the args still feed metadata derivation
  only); they show the "no renderer yet" placeholder. Promoting
  them follows the same pattern as chart (server-tool rename
  + node type + assembler branch).

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
