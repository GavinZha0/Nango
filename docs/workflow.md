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

The chart-data-flow design is documented in `Section 10`.

---

## 1. Positioning
- **Role**: Data engine (workflows/sandboxes) vs UI engine (chat/artifacts).
- **Definition**: A deterministic DAG of typed nodes (	ool/gent/code/sql), 1:1 with an artifact.
- **Equivalence**: Workflows and Agents are peer entities at the runner level (both use entity_run).

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

## 3. Data model

### 3.1 `workflow` table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | NOT NULL |
| `description` | text | Optional |
| `spec` | jsonb | Canonical DAG |
| `visibility` | text | DEFAULT 'private' |
| `created_by` | uuid | FK to `user.id` (ON DELETE SET NULL) |
| `updated_by` | uuid | FK to `user.id` (ON DELETE SET NULL) |
| `created_at` / `updated_at` | timestamp | |

**Indexes**:
- `workflow_created_by_idx`
- `workflow_visibility_idx`
- `workflow_spec_gin_idx` (GIN with `jsonb_path_ops`)
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

## 5. Key flows

- **Save**: POST /api/artifacts/save → reconstructs @path refs via Strategy Z+ → canonicalizes schemas → validates → inserts DB row.
- **Load**: GET /api/artifacts/[id] → executes workflow in memory (no forceFresh) → returns UI bundle.
- **Refresh**: POST /api/artifacts/[id]/refresh → executes with forceFresh=true → records entity_run_event timeline.
- **Modify**: (Backlog) Agent uses modify_workflow MCP tool to patch LLM-emit shape, server re-canonicalizes.

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

At execute time the engine resolves `inputs.dataset` refs → injects rows into `config.dataset.source` → returns merged `option`. The frontend passes `option` verbatim to `<EChartsRenderer />`. See `Section 10 §5.5` for the full chart node contract.

---

## 8. Implementation status
- **Shipped**: Core engine, 5 node types, code/SQL/chart execution, refresh endpoints, artifact integration.
- **Partial**: Admin forensics API (no UI), refresh visual merge in UI.
- **Backlog**: modify_workflow tool, scheduled refresh, public sharing, LLM-authored workflows.

## 9. Related documents

| Document | What it covers |
|---|---|
| [`Section 10`](./Section 10) | Normative node shape reference for LLM authoring |
| [`outcomes.md`](./outcomes.md) | Transient, block-based artifact viewer |
| [`data-sources.md`](./data-sources.md) | SQL node's data-source / DuckDB / Parquet contract |
| [`sandbox.md`](./sandbox.md) | Code node's sandbox path and mount contract |
| [`runner-events.md`](./runner-events.md) | `workflow_node_*` event types emitted by the engine |
| [`orchestrator.md`](./orchestrator.md) | Runner kernel (chat dispatch, supervisor delegation, schedules) |


## 10. Workflow Spec — Node Contract Reference

### 10.1 Two shapes — LLM-emit vs Canonical

The save pipeline is **LLM-emit → canonicalize → validate → persist canonical**. The engine reads only canonical form.

| | LLM-emit | Canonical |
|---|---|---|
| Who writes | LLM, `build-from-events` | `canonicalize.ts` only |
| Who reads | `canonicalize.ts` | engine, validator, recorder |
| UUID fields | absent (display names) | resolved by canonicalize |
| `schema_version` | absent | stamped per node type |
| `input_schema` / `output_schema` | absent | **tool nodes only** — per-instance snapshot from tool registry |
| Output field lists | absent | derived from `NODE_TYPE_REGISTRY` at validate time |

> **Rule**: never put engine-only fields into the LLM-emit schema. Every extra required field raises LLM hallucination cost.

---

### 10.2 Node schema versioning

Each canonical node carries `schema_version: "1"`. The engine dispatches by `(type, schema_version)`:

```ts
const NODE_EXECUTORS = {
  "tool:1": toolNodeV1, "agent:1": agentNodeV1,
  "code:1": codeNodeV1, "sql:1": sqlNodeV1, "chart:1": chartNodeV1,
};
```

Bump the version when a required field is added, removed, or changes meaning. Old executors stay registered so persisted workflows keep running.

---

### 10.3 Common node shape

Every node shares the same top-level skeleton regardless of type:

```jsonc
{
  "id":          0,                        // numeric, stable within spec
  "type":        "tool|agent|code|sql|chart",
  "description": "What this step does",   // required; used by modify_workflow to locate nodes
  "depends_on":  [],                       // upstream node ids (explicit DAG edges)
  "inputs":      { /* type-specific */ },
  // optional execution policy:
  "retries":         { "attempts": 2, "delay_seconds": 1, "backoff": "exponential" },
  "timeout_seconds": 30
}
```

**The strict top-level / inputs rule**: only the fields above may appear at top level. All type-specific data lives under `inputs`. There is no third location.

**Canonicalize adds** `schema_version` and any resolved UUID fields. All keys are **snake_case**.

---

### 10.4 Reference syntax — `@path`

| Sigil | Resolves to | Example |
|---|---|---|
| `@nodes.<id>.<field>` | Upstream node's runtime output | `"@nodes.0.dataset_name"` |
| `@inputs.<key>` | Workflow-level input parameter | `"@inputs.region"` |
| `@context.<path>` | Runtime context (user id, current time) | `"@context.user.id"` |

`@workflow.<key>` is accepted as an alias for `@inputs.<key>`.

**Refs are allowed only** at leaf string values inside `inputs` and in `spec.outputs` map values. Not in `id`, `type`, `description`, `depends_on`, or execution policy fields.

---

### 10.5 Node types

#### 10.5.1 `tool` — server-side or MCP tool call

Shape mirrors the OpenAI/MCP tool-call convention. The LLM writes what it would write as a live tool call.

**LLM-emit**:
```jsonc
{
  "id": 0, "type": "tool", "description": "Find regulatory updates", "depends_on": [],
  "inputs": {
    "name":      "web_search",
    "arguments": { "query": "EU AI Act 2026" }
  }
}
```

**Canonical adds**: `schema_version`, `input_schema` (wrapper with `name: const` + registry args schema), `output_schema` (from registry), `outputs[]` (field names).

---

#### 10.5.2 `sql` — DuckDB SQL extraction

Runs a DuckDB query against a data source, materialises a Parquet snapshot, and returns inline row data for downstream nodes.

**LLM-emit**:
```jsonc
{
  "id": 0, "type": "sql", "description": "Pull monthly sales for 2026", "depends_on": [],
  "inputs": {
    "data_source_name": "prod_pg",
    "sql_text":         "SELECT month, sum(total) AS sales FROM orders WHERE year = 2026 GROUP BY 1",
    "dataset_name":     "monthly_sales_2026"   // optional; engine derives if omitted
  }
}
```

**Canonical adds**: `schema_version`, `inputs.data_source_id` (UUID resolved from slug).

**Runtime outputs** (available as `@nodes.X.<field>`):

| Field | Type | Description |
|---|---|---|
| `dataset_name` | string | Parquet slot name; downstream code/chart nodes mount at `./data/<name>/` |
| `total_rows` | integer | Full result-set count |
| `returned_rows` | integer | Rows delivered inline (≤ total_rows) |
| `rows` | array | Inline row objects — column names vary by query |
| `row_schema` | object | Per-column type metadata, populated even for zero-row results |

---

#### 10.5.3 `agent` — delegate to a built-in agent

Invokes a built-in agent and returns its reply as `{ result: string }`.

**LLM-emit**:
```jsonc
{
  "id": 1, "type": "agent", "description": "Summarise anomalies", "depends_on": [0],
  "inputs": {
    "name":    "Builtin / DataAnalyst",     // <sourceLabel> / <agentName> display string
    "task":    "Summarise the search results in 200 words",
    "context": "@nodes.0.rows"              // optional; single @path ref or literal string
  }
}
```

**Canonical adds**: `schema_version`, `inputs.agent_id` (UUID resolved from display name).

**Runtime outputs**: `{ result: string }` — canonical-fixed for all agent nodes.

---

#### 10.5.4 `code` — sandboxed code execution

Runs Python or JavaScript in an isolated sandbox with optional dataset mounts and runtime parameters.

**LLM-emit**:
```jsonc
{
  "id": 2, "type": "code", "description": "Aggregate to hourly means", "depends_on": [0],
  "inputs": {
    "language":  "python",
    "code_text": "# read ./data/{datasets[0]}, resample 1H, print json.dumps({'rows': [...], 'message': '...'})",
    "datasets":  ["@nodes.0.dataset_name"],   // Parquet mounts at ./data/<name>/
    "params":    { "threshold": 100 }          // injected as NANGO_PARAMS env var
  }
}
```

**Canonical adds**: `schema_version`.

**Runtime outputs — `CodeOutputEnvelope`**:

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | `true` when exit_code === 0 |
| `duration_ms` | integer | Wall-clock execution time |
| `rows` | object[] \| null | Structured data from `"rows"` key in stdout JSON |
| `row_count` | integer \| null | `rows.length`; null when rows is null |
| `row_schema` | object \| null | Per-column type metadata inferred from `rows[0]` |
| `message` | string \| null | From `"message"` key in stdout JSON; fallback = raw stdout |
| `files` | string[] \| null | From `"files"` key (future file-output support) |
| `error` | string \| null | Error text when ok=false (from stderr); null when ok=true |

**Output convention** — code must print exactly one JSON object to stdout:
```python
import json, sys
print("debug", file=sys.stderr)   # logs to stderr — does not affect ok
print(json.dumps({
    "rows":    [{"hour": "2026-01-01T00:00:00Z", "avg": 15.2}, ...],
    "message": "Aggregated 1440 rows to 24 hourly buckets"
}))
```

**v1 constraints**:
- `language: "javascript"` supports `code_text` only — no `datasets`, no `code_file`.
- `inputs.code_file` is accepted by the schema but rejected at runtime (`SPEC_FEATURE_UNSUPPORTED`).
- `params` is injected as `JSON.parse(os.environ['__PARAMS__'])` (Python) or `JSON.parse(process.env['__PARAMS__'])` (JS).

---

#### 10.5.5 `chart` — declarative ECharts output

Stores an ECharts option **template** plus a `@path` ref to upstream row data. The engine merges them at execute time; the browser renders `outputs.option`.

**LLM-emit**:
```jsonc
{
  "id": 3, "type": "chart", "description": "Hourly latency line chart", "depends_on": [2],
  "inputs": {
    "renderer": "echarts",
    "config": {
      "xAxis": { "type": "time" },
      "yAxis": { "type": "value", "name": "Avg Latency (ms)" },
      "series": [{ "type": "line", "encode": { "x": "hour", "y": "avg" } }]
    },
    "dataset": "@nodes.2.rows"    // @path ref to upstream rows array
  }
}
```

**Canonical adds**: `schema_version`.

**Runtime outputs**: `{ option: object }` — the merged ECharts option ready for `<EChartsRenderer />`.

---

### 10.6 Workflow-level shape

```jsonc
{
  "name":         "Latency Analysis",         // required
  "description":  "...",                       // optional
  "input_schema": { /* JSON Schema subset */ }, // optional; declares @inputs.* keys
  "nodes":        [ /* ≥1 node */ ],
  "outputs": {                                  // required; ≥1 entry
    "option": "@nodes.3.option"                 // key → @nodes.X.field ref
  },
  "execution": {                                // optional overrides
    "max_parallelism":  4,
    "timeout_seconds":  120,
    "on_failure":       "stop"   // "stop" | "continue"
  }
}
```

`spec.outputs` drives which field the artifact renders. The key name is stored in `artifact.workflow_output_field`.

---

### 10.7 Error codes

### Save-time (canonicalize + validate)

| Code | When |
|---|---|
| `TOOL_NOT_FOUND` | Tool name not in registry |
| `AGENT_NOT_FOUND` | Agent display name unresolvable or system-role |
| `DATA_SOURCE_NOT_FOUND` | SQL data_source_name slug not found |
| `PROMOTED_TOOL_AS_NODE` | `run_code_in_sandbox` / `extract_dataset_by_sql` / `generate_echarts_config` used as tool node |
| `SPEC_DAG_CYCLE` | Circular dependency detected |
| `SPEC_REF_UNKNOWN_NODE` | `@nodes.X` points to non-existent id |
| `SPEC_REF_UNREACHABLE` | Ref target not in `depends_on` closure |
| `SPEC_REF_UNKNOWN_FIELD` | Referenced field not declared in node's output contract |
| `SPEC_REF_OUTSIDE_INPUTS` | `@path` ref found outside `inputs` / `spec.outputs` |
| `CHART_CONFIG_CONTAINS_REF` | `@path` ref inside `inputs.config` (other than `inputs.dataset`) |
| `CHART_CONFIG_TOO_LARGE` | `inputs.config` exceeds 64 KB |
| `CHART_DATASET_TYPE_MISMATCH` | `inputs.dataset` resolves to non-array at runtime |
| `CHART_DATASET_REF_INVALID` | `inputs.dataset` ref format invalid |
| `VALIDATED_TOOL_AS_NODE` | Save-rejected promoted tool re-attempted |
| `JS_DATASETS_NOT_SUPPORTED` | `language: "javascript"` node has non-empty `inputs.datasets` |
| `SPEC_FEATURE_UNSUPPORTED` | `inputs.code_file` set (v1: runtime-only error) |
| `CODE_NEITHER_TEXT_NOR_FILE` | Neither `code_text` nor `code_file` present |
| `CODE_BOTH_TEXT_AND_FILE` | Both `code_text` and `code_file` present |
| `SPEC_SCHEMA_MISMATCH` | Field value fails Zod shape validation |
| `SPEC_NO_OUTPUTS` | `spec.outputs` is empty |
| `SPEC_TIMEOUT_EXCEEDED` | Node or workflow timeout exceeds hard cap |

### Runtime

| Code | When |
|---|---|
| `CODE_EXECUTION_FAILED` | Sandbox exit_code ≠ 0 |
| `TOOL_EXECUTION_FAILED` | Tool threw an unhandled error |
| `AGENT_EXECUTION_FAILED` | Agent run failed |
| `OUTPUT_SCHEMA_MISMATCH` | Agent output doesn't match `{ result: string }` |
| `TOOL_INPUT_SCHEMA_MISMATCH` | Tool arguments fail AJV validation |
| `REF_UNRESOLVED` | `@path` ref produced `undefined` at execute time |

---

### 10.8 What the LLM must and must not emit

**Must emit**:
- `id` (0-based integers, unique within spec), `type`, `description` (non-empty), `depends_on`, `inputs`
- `inputs.name` for tool/agent; `inputs.language` + source for code; `inputs.data_source_name` + `sql_text` for sql; `inputs.renderer` + `config` for chart

**Must NOT emit**:
- `schema_version`, `input_schema`, `output_schema`, `outputs[]` — canonicalize fills these
- `inputs.agent_id`, `inputs.data_source_id` — resolved by canonicalize from display names
- `output_schema` on any node type — removed; code nodes use CodeOutputEnvelope

**LLM error recovery**: save-time `WorkflowError` messages name the offending node (`nodeId`, `nodeName`) and include a hint. The LLM should patch the named node's `inputs` and re-save.
