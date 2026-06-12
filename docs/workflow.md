# Workflow — V1 Reference

> **Status**: Reflects the current implementation.

---

## 0. Overview

A **workflow** is a saved, deterministic-replayable description of the
data work an agent did in chat. The save flow captures the tool /
agent / code / SQL invocations that produced an artifact, freezes them
into a typed DAG (`workflow.spec` JSONB), and writes one row to the
`workflow` table. Re-running that DAG against the live data sources
later is what the `/api/artifacts/[id]/refresh` endpoint does.

The chart-data-flow design is documented in `workflow-spec.md`.

---

## 1. Positioning

### 1.1 Two-pillar product model

Nango is two engines that share infrastructure:

| Pillar | What it does | Where the code lives |
|---|---|---|
| **Data engine** | "Agents that produce data" — workflow DAGs, data sources, sandbox, SQL extraction. Outputs are typed values. | `src/lib/workflows/`, `src/lib/data-sources/`, `src/lib/sandbox/` |
| **UI engine** | "Agents that produce UI" — chat tools, charts, outcome rendering, artifact pages. Outputs are renderable views. | `src/components/workspace/`, `src/hooks/useOutcomeTools.tsx`, `src/lib/outcomes/` |

A workflow lives entirely on the **data engine** side. UI rendering of
its result is a separate concern handled by the artifact layer. The
chart refactor collapses the fork on the data side (chart becomes a
workflow node) while keeping rendering in the browser.

### 1.2 What a workflow is (and isn't)

Is:
- A captured tool chain from one or more chat turns
- A DAG of typed nodes (`tool` / `agent` / `code` / `sql`)
- Replayable: same inputs → same outputs (modulo external state)
- 1:1 with an artifact at save time (one workflow row per saved
  artifact, populated from the chat trace)

Isn't:
- An LLM-authored DSL the user edits directly. The LLM never types a
  full workflow spec from scratch; it captures and modifies, never
  composes
- A general computation engine. V1 supports five node types and a
  flat-input/output ref system (`@nodes.X.field` / `@inputs.X`)
- A separate scheduler tier. Workflow refresh shares `entity_run` +
  the existing runner, no new dispatch infra

### 1.3 Concept map

```
artifact (one row in `artifact` table)
   ├── workflowId          ← FK to the backing workflow (if any)
   └── workflowOutputField ← which spec.outputs key holds the artifact's data

workflow (one row in `workflow` table)
   ├── spec                ← canonical JSON DAG: { nodes[], outputs{} }
   ├── name / description
   └── visibility (private | public)

entity_run (one row per execution attempt)
   ├── entityKind = "workflow", entitySource = "builtin"
   ├── entityId = workflow.id
   ├── parent_run_id (for agent sub-runs spawned by an agent node)
   └── status / startedAt / finishedAt / errorMessage

entity_run_event (timeline of one run)
   └── type ∈ { started, finished, error,
                workflow_node_attempt_started,
                workflow_node_attempt_failed,
                workflow_node_completed }
```

### 1.4 Workflow ≡ Agent (peer model)

Workflows and agents are **peer entities** at the runner level. Both
are dispatched by `runner.start({ entityKind, entityId, ... })`. The
runner doesn't care whether the entity is a chat agent or a workflow
— it just creates an `entity_run` row, persists events, and waits
for terminal status. This is why workflow refresh and chat dispatch
can share `entity_run` without a separate `workflow_run` table.

---

## 2. Architecture

### 2.1 Layered view

```
┌─────────────────────────────────────────────────────────────────┐
│  HTTP layer — Next.js routes                                    │
│    POST /api/artifacts/save     POST /api/artifacts/[id]/refresh│
│    GET  /api/artifacts/[id]     PATCH /api/artifacts/[id]       │
└──────────────────────────────────┬──────────────────────────────┘
                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│  Artifact orchestration  (src/lib/artifacts/)                   │
│    save-artifact.ts      ← coalesce + build-from-events + write │
│    bundle.ts             ← GET / refresh shared assembly        │
│    execute-workflow.ts   ← engine adapter; recorder + agent run  │
│    refresh-artifact.ts   ← thin wrapper that sets forceFresh    │
│    workflow-run-recorder ← entity_run + event persistence        │
└──────────────────────────────────┬──────────────────────────────┘
                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│  Workflow engine  (src/lib/workflows/engine/)                   │
│    inProcessWorkflowEngine    ← DAG executor                    │
│    cache.ts                   ← per-node L1 (defined, not wired)│
│    execution-context.ts       ← @path ref resolution            │
└──────────────────────────────────┬──────────────────────────────┘
                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│  Engine dependencies  (DI — engine never imports these)         │
│    runAgent       → runner.start (refresh path only)            │
│    runCode        → sandbox adapter (subprocess / local-docker) │
│    getTool        → user tool catalog (builtin-tools/...)       │
│    emitEvent      → recorder.emit or noop                       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Save flow

```
chat (CopilotKit)
   │   user clicks Save on a chart in /outcomes
   ↓
POST /api/artifacts/save
   │   { outcomeId, threadId, name, parentId, ... }
   ↓
save-artifact.ts (src/lib/artifacts/)
   │
   ├── 1. fetch the relevant `entity_run_event` rows for threadId
   │      filtered to the source outcome
   │
   ├── 2. coalesceToolCalls → ToolInvocation[]
   │      assembles streaming chunks back into whole tool calls
   │
   ├── 3. buildFromEvents(invocations, artifactCreatingCallId)
   │      → { spec, strippedFrontendConfig, lineageReport }
   │      • chart tool (generate_echarts_config / generate_<lib>_config)
   │        becomes a type:"chart" node; other artifact creators are
   │        stripped (only data-producing invocations become nodes)
   │      • drops failed (ok:false) invocations
   │      • assigns numeric node ids
   │      • Strategy Z+ walks args for @path refs into upstream node
   │        outputs
   │
   ├── 4. canonicalize(spec, deps) → CanonicalWorkflowSpec
   │      resolves display names → UUIDs (agent, sql nodes),
   │      stamps schema_version; input/output schemas served from
   │      NODE_TYPE_REGISTRY at validate/execute time
   │
   ├── 5. validate(canonical) — last-mile cross-ref checks
   │
   └── 6. ONE DB transaction:
          • INSERT workflow row (with `spec`)
          • INSERT artifact row (workflowId / workflowOutputField)
          • INSERT entity_run_event "artifact_saved" lineage record
```

### 2.3 Refresh flow (GET + POST)

```
GET  /api/artifacts/[id]            POST /api/artifacts/[id]/refresh
   │                                       │
   ↓                                       ↓
buildArtifactBundle(id, ownerId,        buildArtifactBundle(id, ownerId,
  deps, { /* no forceFresh */ })          deps, { forceFresh: true })
   │                                       │
   ↓                                       ↓
1. load artifact + workflow rows        ↑ same shared assembly ↑
2. pick outputField from spec.outputs
3. executeWorkflow({                       │
     workflowId, spec, outputField,        │
     ownerId, workflowName,                │
     forceFresh: ?  })                     │
       │                                   │
       │  forceFresh=true ⇒ ALSO:          │
       │   • startRecording → entity_run   │
       │     row with parent_run_id=null,  │
       │     status=running                │
       │   • emitEvent ← recorder.emit     │
       │     (writes entity_run_event)     │
       │   • runAgent ← real dispatch      │
       │     via runner.start              │
       │                                   │
       │  forceFresh=false ⇒               │
       │   • emitEvent ← noopEmitEvent     │
       │   • runAgent ← stubRunAgent       │
       │     (agent nodes fail loud)       │
       │                                   │
       ↓                                   │
4. inProcessWorkflowEngine.execute(...)    │
5. result.output[outputField] → data       │
6. bundle = { node, workflow, data }       │
                                           │
                                           ↓
                                     respond { node, workflow,
                                                data?, executedAt? }
```

### 2.4 Why the engine ↔ runner DI seam

If `workflows/engine/` directly imported `runner/`, we'd have a cycle:

- `runner/runner.ts` needs to know about workflows (a workflow IS a
  dispatch target with `entityKind: "workflow"`)
- `workflows/engine/in-process.ts` needs to dispatch agent nodes via
  the runner

The DI cut: engine declares an interface (`WorkflowEngineDependencies`
with `runAgent`, `runCode`, `getTool`, `emitEvent`, `cache?`), and the
artifact-side adapter (`execute-workflow.ts`) provides concrete
implementations. The engine module stays runner-blind.

This is also why `execute-workflow.ts` lives under `src/lib/artifacts/`
— it knows about both engine internals and runner internals, which a
"pure engine" module shouldn't.

### 2.5 Design principles

**Three-stage save pipeline: LLM-emit → canonicalize → validate.**
The LLM produces a minimal spec (display names, no schemas). Canonicalize
(async) resolves names to UUIDs via real DB lookups and stamps
`schema_version`; input/output schemas are served from
`NODE_TYPE_REGISTRY` at validate/execute time, not stamped per-instance.
Validate checks DAG invariants and cross-references. Persisted spec is
always canonical.

**No first-class `/api/workflows` endpoints.**
Workflows are always accessed through their owning artifact
(`/api/artifacts/[id]`). Workflow access = artifact access.

**Strategy Z+ ref reconstruction.**
Save is zero-LLM: `build-from-events.ts` reconstructs `@path` refs
deterministically by comparing upstream tool result values against
downstream tool argument values. Ambiguous matches keep literal values.

**Chart nodes: static template + data ref.**
Chart nodes store an ECharts option template (no inline data) plus a
`@path` ref to upstream rows under `inputs.dataset`. The engine merges
them at execute time; the browser renders. The "not-refreshable" fallback
bakes data into `inputs.config` when Strategy Z+ cannot match the
chart's dataset to any upstream output.

### 2.6 Known constraints

| Constraint | Detail |
|---|---|
| Strategy Z+ scope | Only top-level scalar and array fields are matched for ref reconstruction; nested objects inside tool arguments are not walked |
| SQL node schemas | SQL nodes carry no per-instance `input_schema` / `output_schema`; their fixed output contract is declared in `NODE_TYPE_REGISTRY["sql:1"]` |
| System-role agents | supervisor / secretary / evaluator agents cannot be workflow nodes (`AGENT_NOT_FOUND`) |
| JavaScript datasets | `code` nodes with `language: "javascript"` cannot consume `inputs.datasets` (no Parquet reader in v1 Node.js sandbox) |
| Chart single binding slot | Only `inputs.dataset` is a ref carrier; `@path` refs inside `inputs.config` are rejected (`CHART_CONFIG_CONTAINS_REF`) |
| `code_file` for JavaScript | Not supported in v1 (`SPEC_FEATURE_UNSUPPORTED`) |
| Code node output | Fixed CodeOutputEnvelope; stdout must be valid JSON with "rows" + "message" keys |
| Condition / loop nodes | Not designed; `SPEC_FEATURE_UNSUPPORTED` if attempted |

### 2.7 File responsibility table

| File | Owns |
|---|---|
| `src/lib/workflows/spec/schema.ts` | Zod types for LLM-emit + canonical spec; 4 node types; `@path` ref grammar |
| `src/lib/workflows/spec/canonicalize.ts` | LLM-emit → canonical (agent name → UUID, defaults) |
| `src/lib/workflows/spec/validate.ts` | Post-canonicalize cross-ref checks (refs resolve, output refs valid, etc.) |
| `src/lib/workflows/spec/refs.ts` | `@path` parser + resolver |
| `src/lib/workflows/spec/hash.ts` | Stable JSON hash (cache key primitives) |
| `src/lib/workflows/engine/in-process.ts` | DAG executor, lifecycle events |
| `src/lib/workflows/engine/execution-context.ts` | Per-run state (node outputs, ref resolution) |
| `src/lib/workflows/engine/cache.ts` | L1 LRU class + key derivation (not yet wired) |
| `src/lib/workflows/engine/scheduler.ts` | Topological order, parallelism control |
| `src/lib/workflows/nodes/registry.ts` | Node type registry: `NodeTypeDescriptor`, `NODE_TYPE_REGISTRY`, `assembleCodeOutput` call chain; provides `getOutputFields()` for validate.ts |
| `src/lib/sandbox/code-output.ts` | `CodeOutputEnvelope` type + `assembleCodeOutput()` — shared by `run_code_in_sandbox`, `run_skill_script`, and the workflow code-node executor |
| `src/lib/workflows/nodes/tool-node.ts` | Tool invocation (ref-resolved input → tool.execute → JSON output) |
| `src/lib/workflows/nodes/agent-node.ts` | Agent invocation via `deps.runAgent` |
| `src/lib/workflows/nodes/code-node.ts` | Python sandbox via `deps.runCode` |
| `src/lib/workflows/nodes/sql-node.ts` | `extract_dataset_by_sql` wrapper, parquet cache key |
| `src/lib/workflows/nodes/with-retries.ts` | Per-node retry loop, emits attempt events |
| `src/lib/workflows/nodes/schema-validator.ts` | JSON Schema runtime validation |
| `src/lib/workflows/build-from-events.ts` | Chat-event → spec build pipeline (Strategy Z+ ref reconstruction) |
| `src/lib/artifacts/save-artifact.ts` | Save endpoint orchestrator |
| `src/lib/artifacts/bundle.ts` | GET / refresh shared bundle assembly |
| `src/lib/artifacts/execute-workflow.ts` | Engine adapter: catalog → deps, recorder, runAgent bridge |
| `src/lib/artifacts/refresh-artifact.ts` | Thin wrapper: `buildArtifactBundle(..., { forceFresh: true })` |
| `src/lib/artifacts/workflow-run-recorder.ts` | entity_run + event persistence for refresh runs |
| `src/lib/artifacts/coalesce-tool-calls.ts` | Streamed `tool_call_chunk` → whole `ToolInvocation` |

---

## 3. Data model

### 3.1 `workflow` table

```sql
workflow (
  id            uuid PK,
  name          text   NOT NULL,
  description   text,
  spec          jsonb  NOT NULL,             -- canonical DAG
  visibility    text   NOT NULL DEFAULT 'private',
  created_by    uuid   → user.id ON DELETE SET NULL,
  updated_by    uuid   → user.id ON DELETE SET NULL,
  created_at    timestamp DEFAULT now(),
  updated_at    timestamp DEFAULT now()
)
```

Indexes:
- `workflow_created_by_idx` — "my workflows" listing
- `workflow_visibility_idx` (partial WHERE visibility='public') — tenant-wide shared
- `workflow_spec_gin_idx` (GIN with `jsonb_path_ops`) — reverse dependency queries: "which workflows reference data source X / MCP tool Y / agent Z?"

### 3.2 Relationships

```
        ┌──────────┐         ┌──────────┐         ┌────────────┐
        │ artifact │ ───────→│ workflow │         │ entity_run │
        │          │ FK SET  │          │         │            │
        │ kind=    │  NULL   │ spec=DAG │         │ entityKind=│
        │ "chart"  │         │          │         │  "workflow"│
        │ content= │         │          │         │ entityId=  │
        │  {blocks}│         │          │         │  workflow  │
        │workflowId│         │          │         │  .id       │
        └──────────┘         └──────────┘         └────────────┘
                                                        │
                                          one row per   │
                                          refresh exec  │
                                          (forceFresh)  ↓
                                                  ┌──────────────────┐
                                                  │entity_run_event[]│
                                                  │workflow_node_*   │
                                                  └──────────────────┘
```

**FK behaviour**:
- `artifact.workflow_id` → `workflow.id` `ON DELETE SET NULL` — deleting a workflow leaves the artifact with its content snapshot but no replay path
- `entity_run.entity_id` is **not** a FK (polymorphic across agent / team / workflow targets) — deleting a workflow leaves orphaned run history rows. Read-only forensics; no integrity risk

> **Artifact snapshot fields** (added in Stage 3): `snapshot jsonb`, `snapshot_at timestamptz`, `view_mode text DEFAULT 'snapshot'`. GET returns stored snapshot when `view_mode='snapshot'`; POST `/snapshot` saves a new snapshot. See `save-snapshot.ts`.

### 3.3 `entity_run_event` types for workflows

Five of the eleven `EntityRunEventType` enum values are used by
workflow runs:

| Type | When | Payload |
|---|---|---|
| `started` | run begins (after entity_run row INSERT) | engine `workflow_started` event |
| `finished` | engine returned success | engine `workflow_completed` (output) |
| `error` | engine threw WorkflowError | engine `workflow_failed` (errorCode, message) |
| `workflow_node_attempt_started` | each node attempt begins | nodeId, attempt # |
| `workflow_node_attempt_failed` | node attempt threw before retry exhausted | nodeId, attempt #, errorCode, message |
| `workflow_node_completed` | node finished (success or cache hit) | nodeId, attempt #, durationMs, cached?, outputs |

Chat path uses the other types (`message`, `reasoning`,
`tool_call_chunk`, `tool_call_result`, `degraded`).

---

## 4. Spec format

### 4.1 LLM-emit vs canonical

Two shapes for the same spec, both Zod-validated:

| Shape | When | Notes |
|---|---|---|
| **LLM-emit** | What `build-from-events.ts` produces and what (future) `modify_workflow` accepts. Agents are addressed by `agent` display name (`"data_analyst"`). Output schemas may be omitted; canonicalize fills them. |
| **Canonical** | What lives in `workflow.spec` on disk and what the engine consumes. Agent UUIDs resolved (`agentId: "<uuid>"`), default output schemas materialized, dataset slugs filled (`name: "<slug>"` for SQL nodes), output bucket tags present. |

The save pipeline is always **LLM-emit → canonicalize → validate →
persist canonical**. The engine never sees LLM-emit shape; the modify
flow always reads / writes LLM-emit and re-canonicalizes on save.

### 4.2 Node types

V1 ships **five** node types, each its own Zod variant:

```ts
NodeTypeSchema = z.enum(["tool", "agent", "code", "sql", "chart"]);
```

#### 4.2.1 Tool node

A built-in or MCP server-side tool. Examples: `web_search`,
`run_ssh_command`, `get_skill`. NOT `extract_dataset_by_sql`
(promoted to `sql` node), NOT `run_code_in_sandbox`
(promoted to `code` node), NOT `generate_echarts_config` /
`generate_<lib>_config` (promoted to `chart` node).
These names are rejected at save time with `PROMOTED_TOOL_AS_NODE`.

```jsonc
{
  "id": 0,
  "type": "tool",
  "description": "Find recent regulatory updates",
  "inputs": {
    "name":      "web_search",
    "arguments": { "query": "EU AI Act 2025" }
  },
  "depends_on": [],
  "output_schema": { "type": "object", "properties": { /* registry-provided */ } },
  "retries": { "attempts": 2, "backoff": "exponential", "delay_seconds": 1 },
  "timeout_seconds": 30
}
```

#### 4.2.2 Agent node

A built-in agent invocation. The output contract is canonical-fixed:
`{ result: string }`. The agent output schema is served from
`NODE_TYPE_REGISTRY["agent:1"]` — not stamped per-instance.
The runner returns plain text; `execute-workflow.ts` wraps as
`{ result: summary }` on the refresh path.

```jsonc
{
  "id": 1,
  "type": "agent",
  "depends_on": [0],
  "inputs": {
    "name":     "data_analyst",
    "agent_id": "<uuid>",          // canonical: resolved by canonicalize
    "task":     "Summarise the search results in 200 words",
    "context":  "@nodes.0.results" // optional; whole-field @path ref
  }
}
```

#### 4.2.3 Code node

Python or JavaScript script in the sandbox. Always returns a fixed
`CodeOutputEnvelope`: `{ ok, duration_ms, rows, row_count, row_schema,
message, files, error }`. Code must print a JSON object to stdout with
`rows` (array) and optionally `message`. `row_schema` is auto-inferred
from `rows[0]`. See `workflow-spec.md §5.4` for the full contract.

```jsonc
{
  "id": 2, "type": "code", "depends_on": [1],
  "inputs": {
    "language":  "python",
    "code_text": "# aggregate and print json.dumps({'rows': [...], 'message': '...'})",
    "datasets":  ["@nodes.1.dataset_name"],
    "params":    { "threshold": 100 }
  }
}
```

#### 4.2.4 SQL node

A `data_source` + SQL pair that materialises a Parquet snapshot.
Outputs are `{ dataset_name, total_rows, returned_rows, rows,
row_schema }`; downstream code nodes reference
`@nodes.<id>.dataset_name` to mount the dataset under
`./data/<dataset_name>/` in the sandbox cwd.

```jsonc
{
  "id": 0,
  "type": "sql",
  "depends_on": [],
  "inputs": {
    "data_source_name": "prod_pg_readonly", // slug; canonicalize stamps data_source_id (UUID)
    "sql_text":         "SELECT customer_id, sum(amount) AS total FROM orders GROUP BY 1",
    "dataset_name":     "customer_totals_2026" // optional; engine derives if omitted
  }
}
```

#### 4.2.5 Chart node

A declarative chart-render step. Stores an ECharts **option template**
(no data) under `inputs.config` and a `@path` ref to upstream row data
under `inputs.dataset`. At execute time the engine fills
`config.dataset.source` with the resolved rows and returns
`{ option }` — rendering happens in the browser.

When `build-from-events` cannot match a `generate_echarts_config`
call's inline data to any upstream output, the chart is saved as
not-refreshable (literal `config`, absent `dataset` ref). The UI
surfaces a "not refreshable" indicator in that case.

```jsonc
{
  "id": 3,
  "type": "chart",
  "depends_on": [0],
  "inputs": {
    "renderer": "echarts",
    "config": {
      "xAxis": { "type": "category" },
      "yAxis": { "type": "value" },
      "series": [{ "type": "bar", "encode": { "x": "month", "y": "sales" } }]
      // dataset.source is absent — engine fills it from inputs.dataset at execute time
    },
    "dataset": "@nodes.0.rows"   // OPTIONAL; omitted for not-refreshable charts
  }
  // output_schema canonical-fixed to { option: object }
}
```

### 4.3 `@path` reference grammar

References live in node `inputs` values (and `spec.outputs`):

| Sigil | Resolves to | Example |
|---|---|---|
| `@nodes.<id>.<field>` | upstream node's output field | `"@nodes.0.dataset_name"` → SQL node 0's parquet slug |
| `@inputs.<key>` | workflow-level input parameter | `"@inputs.region"` (declared in `spec.input_schema.properties`) |
| `@context.<path>` | per-run runtime context | `"@context.user.id"` |

> `@workflow.<key>` is a backward-compat alias for `@inputs.<key>`;
> new specs should use `@inputs.<key>`.

Resolution is **strictly typed at validate time** (the engine asserts
the upstream node declares a matching `output` key) and **lazily
resolved at execute time** (`execution-context.ts:resolveRefs`).

`spec.outputs` is a flat `Record<string, "@path">` declared at the
top level:

```jsonc
{
  "outputs": {
    "result":     "@nodes.2.stdout",
    "total_rows": "@nodes.0.total_rows"
  }
}
```

`artifact.workflow_output_field` picks **one** key from this map to
be the artifact's primary data. The other keys are forensic / future-
use.

---

## 5. Key flows

### 5.1 Save-as-workflow (chat → spec → DB)

Entry: `POST /api/artifacts/save` with `{ outcomeId, threadId, name,
parentId, ... }`.

Steps (all in `save-artifact.ts`):

1. **Load context** — query `entity_run_event` rows for the source
   thread, filtered to the run that produced this outcome
2. **Coalesce** — `coalesceToolCalls(events)` stitches streaming
   `tool_call_chunk` rows into complete `ToolInvocation { callId,
   toolName, input, output, ok }` records
3. **Build spec** — `buildFromEvents(invocations,
   artifactCreatingCallId)`:
   - If the artifact creator is `generate_echarts_config` (or any
     `generate_<lib>_config` variant), the tool invocation becomes a
     `type: "chart"` workflow node; the chart option is the workflow
     output. For other artifact creators (e.g. `render_html`), the
     creator is stripped and only data-producing invocations become nodes.
   - Filter envelope-failed (`ok: false`) invocations
   - Assign numeric ids
   - Walk each invocation's args via Strategy Z+ to find values
     that match an upstream invocation's output → emit a `@path` ref;
     untouched literals stay literal
4. **Canonicalize** — `canonicalize(spec, deps)` (async):
   - Resolve `agent` display names → `agentId` UUIDs (via
     `BuiltinAgentCatalog`)
   - Fill `output_schema` from registries:
     `DEFAULT_AGENT_OUTPUT_SCHEMA` for agents, tool registry's
     declared schema for tool nodes, default field lists for code /
     sql nodes
   - Dependencies are real DB-backed resolvers provided by
     `buildProductionSaveDeps(ownerId)` from `save-deps.server.ts`
5. **Validate** — `validate(canonical)` ensures refs resolve and
   declared outputs are reachable from `spec.outputs`
6. **Persist** — one DB transaction:
   - INSERT `workflow` row
   - INSERT `artifact` row (`workflowId` + `workflowOutputField` +
     `strippedFrontendConfig` for display metadata)
   - INSERT an `entity_run_event` row tagging the save (lineage)

### 5.2 Load + execute (GET artifact page)

Entry: `GET /api/artifacts/[id]`.

```
1. buildArtifactBundle(id, ownerId, productionDeps)
2. getArtifact → ArtifactEntity (owns-by check)
3. if (folder OR no workflowId) return { node } and stop
4. getWorkflow → WorkflowEntity
5. pick outputField (from artifact.workflowOutputField, fallback first key)
6. executeWorkflow({ workflowId, spec, outputField, ownerId,
                     workflowName }) — NO forceFresh
     → engine.execute() with stubRunAgent + noopEmitEvent
     → result.output[outputField] = "data"
7. return { node, workflow, data, fromCache: false, executedAt }
```

`productionDeps` is the shared `BundleDeps` object exported from
`get-artifact.ts` — it wires `loadArtifact`, `loadWorkflow`, and
`executeWorkflow` for the production code path. The refresh path
reuses the same deps, only differing by `{ forceFresh: true }`.

GET runs the workflow but **persists nothing** to `entity_run`. The bundle
— including fresh `data` from the executed workflow — is returned to the
client. The refresh trigger UI and chart data merge are pending (see §8.2 Partial).

### 5.3 Refresh (POST refresh)

Entry: `POST /api/artifacts/[id]/refresh` (no body).

```
1. refreshArtifact(id, ownerId)
2. buildArtifactBundle(... , { forceFresh: true })
3. executeWorkflow({ ..., forceFresh: true, workflowName })
4. startRecording({ workflowId, workflowName, ownerId })
     → INSERT entity_run (status=running, initiator=user,
        entityKind=workflow, entitySource=builtin,
        inputTask=`Refresh workflow: ${name}`)
     → recorder.runId = entity_run.id
5. wire engine deps:
     emitEvent  ← recorder.emit (writes entity_run_event rows)
     runAgent   ← buildRealRunAgent(ownerId)  (runner.start dispatch)
     runId      ← recorder.runId
6. engine.execute({ runId, spec, ... })
     for each agent node:
       runner.start({ entityId, mode: sync, parentRunId: runId,
                      initiator: user, ownerId, ... })
       → agent sub-run gets its OWN entity_run row, parent_run_id
         pointing at the workflow run
7. recorder.flush() — await all in-flight event writes
8. if success: recorder.succeed() → UPDATE entity_run SET status=succeeded
   if WorkflowError or throw: recorder.fail(err) → status=failed,
     errorMessage=err.message
9. respond { node, workflow, data?, executedAt? }
```

The recorder calls `flush()` before `finalizeRun` (both `succeed` and
`fail` paths) to ensure all buffered `entity_run_event` writes have
settled before the terminal status update.

Known gap: the frontend does not yet expose a refresh trigger button
or merge `bundle.data` (the fresh execution result) into the rendered
chart view. Tracked in §8.2 Partial.

### 5.4 Modify via agent (designed, not built)

The plan calls for a `modify_workflow` MCP tool the right-panel
chatbot uses to edit a saved spec. The user says "change the date
range to last 30 days"; the agent reads the spec via `get_workflow`,
emits a patched LLM-emit version, and the server re-canonicalizes
and writes it back.

Status: designed, not implemented. Lives in the backlog (§8.3).

---

## 6. API surface

| Endpoint | Method | Purpose | Status |
|---|---|---|---|
| `/api/artifacts` | `POST` | Create a folder | ✅ |
| `/api/artifacts/tree` | `GET` | Tree view for the artifact panel | ✅ |
| `/api/artifacts/save` | `POST` | Save-as-workflow (the canonical creation path; §5.1) | ✅ |
| `/api/artifacts/[id]` | `GET` | Render-ready bundle (§5.2) | ✅ |
| `/api/artifacts/[id]` | `PATCH` | Rename / move / change content config | ✅ |
| `/api/artifacts/[id]` | `DELETE` | Hard delete (workflow row stays, FK→NULL) | ✅ |
| `/api/artifacts/[id]/refresh` | `POST` | Force-fresh re-execute (§5.3) | ✅ backend only |
| `/api/admin/runs/[id]` | `GET` | Run detail + event timeline (chat + workflow) | ✅ |
| ~~`/api/workflows`~~ | — | Direct workflow CRUD | 🚫 deliberately not exposed |

No standalone workflow editor endpoints. Workflows are accessed only
through their owning artifact.

---

## 7. Chart data flow

At execute time the engine resolves `inputs.dataset` refs → injects rows into `config.dataset.source` → returns merged `option`. The frontend passes `option` verbatim to `<EChartsRenderer />`. See `workflow-spec.md §5.5` for the full chart node contract.

---

## 8. Implementation status

### 8.1 Shipped ✅

All V1 capabilities listed below are shipped and live in the codebase.
This includes: the `workflow` table and indexes (including GIN), the
spec schema (Zod, 5 node types, canonical / LLM-emit split), the
`@path` ref system, the in-process DAG engine with DI and retries,
the `(type:version)` executor dispatch table, the L1 per-node cache
class (defined but not yet wired), `build-from-events` with Strategy
Z+, the full `save-artifact` orchestrator, GET / PATCH / refresh
artifact endpoints, the real executor in `execute-workflow.ts`,
code-node execution (Python + JavaScript, subprocess mode, `params`
injection, `code_file` support), SQL-node execution with inline-vs-
cached engine policy, chart-node template + data merge (single and
multi-dataset refs), the workflow graph visualization component, run
recording with `entity_run` + event persistence on refresh, and agent
dispatch via `runner.start` on the refresh path.

### 8.2 Partial ⚠️

| Capability | Backend | Frontend |
|---|---|---|
| Refresh + visual update | ✅ endpoint works, engine re-runs | ❌ no refresh button, no data merge into chart |
| Admin run forensics | ✅ `/api/admin/runs/[id]` reads the run history | ❌ no `/admin/run` UI (backend ready, frontend missing) |
| Capability degradation log | ✅ `degraded` event type exists | ⚠️ no UI surface yet |

### 8.3 Backlog

**V1.x — unblocked:**
- `modify_workflow` + `get_workflow` agent tools — chat-driven spec edits
- `/admin/run` detail page — backend ready, frontend missing
- Scheduled refresh — `schedule` table supports `entity_kind='workflow'`; no UI
- Workflow visibility = `public` sharing UX — flag in schema, no UI
- Compare view — side-by-side snapshot vs live chart comparison
- `sql.inline_max_rows` cap increase — requires executor to read Parquet directly
- Other artifact types as workflow nodes — `render_html` / `render_markdown` follow the chart promotion pattern

**V2 / out of scope:**
- LLM-authored workflows from scratch (V1 only captures + modifies)
- Multi-tenant workflow marketplace / forking
- Workflow versioning history (`updatedAt` is the only checkpoint)
- Streaming execution output to the artifact page
- Cross-thread workflow reuse (saved workflow as an on-demand tool)
- Nested `workflow` node (DAG composition)
- `condition` / `loop` node types

---

## 9. Related documents

| Document | What it covers |
|---|---|
| [`workflow-spec.md`](./workflow-spec.md) | Normative node shape reference for LLM authoring |
| [`artifact-evolution.md`](./artifact-evolution.md) | Artifact subsystem (UI engine) current state and backlog |
| [`data-visualization.md`](./data-visualization.md) | Chat-time chart generation (outcomes panel design) |
| [`data-sources.md`](./data-sources.md) | SQL node's data-source / DuckDB / Parquet contract |
| [`sandbox.md`](./sandbox.md) | Code node's sandbox path and mount contract |
| [`runner-events.md`](./runner-events.md) | `workflow_node_*` event types emitted by the engine |
| [`orchestrator.md`](./orchestrator.md) | Runner kernel (chat dispatch, supervisor delegation, schedules) |
