# Workflow Spec — Node Contract Reference

> **Audience**: LLMs authoring workflow nodes, developers extending or debugging the spec.
> **Sibling doc**: [`workflow.md`](./workflow.md) — runtime model, architecture, design principles, backlog

---

## 1. Two shapes — LLM-emit vs Canonical

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

## 2. Node schema versioning

Each canonical node carries `schema_version: "1"`. The engine dispatches by `(type, schema_version)`:

```ts
const NODE_EXECUTORS = {
  "tool:1": toolNodeV1, "agent:1": agentNodeV1,
  "code:1": codeNodeV1, "sql:1": sqlNodeV1, "chart:1": chartNodeV1,
};
```

Bump the version when a required field is added, removed, or changes meaning. Old executors stay registered so persisted workflows keep running.

---

## 3. Common node shape

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

## 4. Reference syntax — `@path`

| Sigil | Resolves to | Example |
|---|---|---|
| `@nodes.<id>.<field>` | Upstream node's runtime output | `"@nodes.0.dataset_name"` |
| `@inputs.<key>` | Workflow-level input parameter | `"@inputs.region"` |
| `@context.<path>` | Runtime context (user id, current time) | `"@context.user.id"` |

`@workflow.<key>` is accepted as an alias for `@inputs.<key>`.

**Refs are allowed only** at leaf string values inside `inputs` and in `spec.outputs` map values. Not in `id`, `type`, `description`, `depends_on`, or execution policy fields.

---

## 5. Node types

### 5.1 `tool` — server-side or MCP tool call

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

**Notes**:
- `inputs.name` is const-pinned at save time — the chosen tool is frozen.
- `inputs.arguments` values may contain `@path` refs.
- Validate rejects `run_code_in_sandbox`, `extract_dataset_by_sql`, `generate_echarts_config` with `PROMOTED_TOOL_AS_NODE` — use the dedicated node types instead.

---

### 5.2 `sql` — DuckDB SQL extraction

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

**Notes**:
- `dataset_name` is optional; engine derives `wf_<runId-first-8>_n<id>` when omitted.
- Re-running with the same `dataset_name` overwrites the slot (last-write-wins).
- `@inputs.*` and `@nodes.*` refs in `sql_text` are resolved before execution.

---

### 5.3 `agent` — delegate to a built-in agent

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

**Notes**:
- Only `role = null` (regular) agents are allowed. System-role agents (supervisor / secretary / evaluator) surface `AGENT_NOT_FOUND`.
- `task` and `context` accept a single `@path` ref. String interpolation (`"... @nodes.0.x ..."`) is not supported in v1.

---

### 5.4 `code` — sandboxed code execution

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

### 5.5 `chart` — declarative ECharts output

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

**Notes**:
- `config` is a template — no inline `dataset.source`. The engine injects it from `inputs.dataset` at execute time.
- `inputs.dataset` is optional. When absent, `config` must contain baked-in data (not-refreshable fallback; shown in UI).
- Any `@path` ref inside `config` (other than `inputs.dataset`) is rejected at save time (`CHART_CONFIG_CONTAINS_REF`).
- `inputs.config` size is capped at 64 KB (`CHART_CONFIG_TOO_LARGE`).

---

## 6. Workflow-level shape

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

## 7. Error codes

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

## 8. What the LLM must and must not emit

**Must emit**:
- `id` (0-based integers, unique within spec), `type`, `description` (non-empty), `depends_on`, `inputs`
- `inputs.name` for tool/agent; `inputs.language` + source for code; `inputs.data_source_name` + `sql_text` for sql; `inputs.renderer` + `config` for chart

**Must NOT emit**:
- `schema_version`, `input_schema`, `output_schema`, `outputs[]` — canonicalize fills these
- `inputs.agent_id`, `inputs.data_source_id` — resolved by canonicalize from display names
- `output_schema` on any node type — removed; code nodes use CodeOutputEnvelope

**LLM error recovery**: save-time `WorkflowError` messages name the offending node (`nodeId`, `nodeName`) and include a hint. The LLM should patch the named node's `inputs` and re-save.
