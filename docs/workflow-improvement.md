# Workflow Dataflow, Parameters, and Filters (Spec v2)

> **Status:** Active Implementation. **Phase 0 (Early-Bird Groundwork & Hardening) is COMPLETE (tested & verified)**; Phase 1 (Spec v2 Engine Rewrite) is queued next. See `workflow.md`, `artifact-filters.md`, `data-sources.md`, and `sandbox.md` for existing behavior. Existing workflow rows are deleted rather than migrated (S10, D9); the execution plan is §9.

## 0. Design principles

These principles are the premises for every later section. When a later rule seems arbitrary, the reason is here.

### 0.1 Mandates

1. **Re-architecture, not patchwork.** The goal is a foundation that can carry multi-source, multi-step analysis, not a patch on the v1 engine. Phase 1 is an engine rewrite (§9).
2. **Zero legacy baggage.** The product is pre-launch. The design ignores compatibility with v1 specs and data. Existing workflow rows are deleted (S10, D9).
3. **AI-native JSON orchestration (the core focus).** The workflow's fundamental contract is a strictly validated JSON document, not internal UI state.
   - *Why JSON.* JSON is the structured output dialect LLMs produce most reliably. An agent can generate, read, and repair a workflow as a co-pilot, a human can inspect it, and the server can validate it completely before anything runs. UI layout (graph positions, panel state) stays out of the spec.
   - *Why this shape.* LLMs generate tokens sequentially. A node therefore refers **backward** to nodes it consumes (`@nodes.<id>.<field>`), never forward in the style of Node-RED `wires`, so the model never has to anticipate nodes it has not written yet. Compile orders nodes from those refs and rejects cycles. A strict tagged union (`type: "sql" | "code" | ...`) with a fixed `inputs` shape per type, parsed without passthrough, prevents parameter drift. Refs are two segments and whole-field only, so there is no expression language to hallucinate.
   - *Three pillars.* 1) Strongly typed Zod schemas as the single source of truth for the spec (§2). 2) Dual-track data passing: dataset pointers for large data, complete bounded rows for charts (§0.2, §3). 3) Safe SQL parameterization through a dedicated compiler, never string splicing (§5.3).
4. **Two authoring contexts, one execution path (Tool vs Node).** See §0.3.
5. **Uncompromising credential boundary.** Database extraction, credential handling, and SQL policy enforcement stay in the Node.js main process. Database credentials or connection strings are **never** passed into the sandbox, not even to bypass a Node.js I/O bottleneck. The sandbox receives only Parquet files on its read-only mount and JSON parameters.

### 0.2 Ground truths: The Three-Tier Pipeline & Dual-Track Data

To understand the execution contract, one must visualize the macro data flow. The engine is a **high-throughput, memory-conscious data computation pipeline** built on three tiers and two data tracks.

#### 0.2.1 Unified Three-Tier Filtering Pipeline

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ UI Layer: Artifact Filter Panel (RJSF Form / Dynamic Options from options_source)      │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ Filter inputs: { date_range, initiator, ... }
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Workflow Engine Dispatch: Injects inputs via @inputs.<key>                             │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Source SQL Pushdown (Primary / Optimal)                                        │
│  - Type-aware safe parameter handling: scalars typed & escaped, arrays expanded        │
│  - DuckDB COPY TO Parquet: Materializes full filtered result to disk                   │
│  - Returns: preview rows in `rows` + `dataset_name` pointer + `row_schema`             │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ Parquet mount (`./tmp/data/<dataset_name>/`)
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Tier 2: Resident Sandbox In-Place Pipeline (DuckDB / Pandas)                           │
│  - Runs inside warm, persistent sandbox (Python / JS)                                  │
│  - DuckDB In-Memory over Parquet: `duckdb.query("SELECT * FROM read_parquet(...)")`    │
│  - Pandas / ML: Anomaly detection, multi-SQL dataset merge, rolling stats              │
│  - Emits: Compact aggregated rows directly intended for visualization                  │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ Summarized rows JSON (< 1,000 points)
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Tier 3: ECharts Client-Side Transform (Terminal Viewport Slicing)                      │
│  - Native ECharts 5+ `dataset.transform` (filter, sort, aggregate)                     │
│  - Instant UI interactions (legend toggling, client-side sorting) without server calls │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Each tier is optional when its contract allows:
| Tier | Data path | Responsible for | Not responsible for |
|---|---|---|---|
| Source SQL | Source → full Parquet + bounded `rows` | Filtering and grouping close to the source; filter pushdown; materializing results | Rendering; running Python; handling credentials outside the data-source layer |
| Python sandbox | Read-only shared Parquet → bounded aggregated `rows` | Multi-source joins, time series, statistics, anything impractical in source SQL | Owning credentials or DB connections; keeping state between runs |
| ECharts (browser) | Small complete `rows` → rendered chart | Rendering, legend interaction, presentation-only transforms such as sorting | Re-applying SQL filters; processing raw or full datasets |

#### 0.2.2 Dual-Track Data Contract (Pointers vs Previews)

Analytical results are often tens of thousands to millions of rows. They never enter agent context, the Node.js heap as a whole, events, snapshots, or the browser.

```text
SQL node
├─ Disk: shared cache directory/**/*.parquet ← full result (e.g. 500,000)
└─ Output bag:
   ├─ dataset_name ← [pointer] heavy path → code nodes (sandbox reads Parquet)
   ├─ total_rows ← [metadata]
   ├─ returned_rows ← [metadata] equals total_rows only when rows are complete
   ├─ row_schema ← [metadata] what an agent needs to write analysis code
   └─ rows ← [inline] ≤ workflow inline budget; chart input only when complete
```

The engine adapts dynamically based on data volume:
1. **Small Data Scenario (Total Rows ≤ inline budget)**: The `rows` array contains the **complete dataset**. Downstream Chart nodes and UI renderers bind directly to `@nodes.X.rows` (the **Lightweight Path**). While the Parquet file is still written for consistency, the inline `rows` serves as the complete, lightweight payload.
2. **Large Data Scenario (Total Rows > inline budget)**: `rows` acts strictly as a **truncated preview** to prevent Node.js heap exhaustion and LLM context window blowouts. Downstream analytical nodes must use the Parquet pointer via `@nodes.X.dataset_name` (the **Heavy Data Path**). Code inside the Python sandbox queries the full dataset at C++/Rust speed over the disk-resident Parquet files, which emits small aggregated rows for the final chart.

3. **No in-process Node.js transform.** The Node.js process has no zero-copy Parquet engine, and loading full datasets into its heap would hurt every API request. Transformations happen only in source SQL, the sandbox, or presentation-only ECharts transforms. The only Parquet reads in Node.js are bounded inline reads (at most the inline budget) that produce `rows`.

4. **Sandbox capabilities.** The Dify sandbox is a persistent, warm service started with the system (no per-run container start). It mounts the shared dataset cache read-only, and that mount does not change per run. Libraries are pre-installed from `docker/dify-sandbox/requirements.txt` (generated by `pnpm sandbox:build`): `duckdb`, `pandas`, `numpy`, `pyarrow`, `pytz`, `matplotlib`, `seaborn`. There is no `polars`, no runtime installation, and no network. The service is persistent, but each code execution is independent: no variables or state carry over between calls.

### 0.3 Tool vs Node: contract layering

Two authoring contexts.
| Context | Actor | Input form | Workflow awareness |
|---|---|---|---|
| Exploration (chat) | Chat agent | `tool_name` + literal, immediately executable `arguments` | None |
| Orchestration (artifact) | Human in the Inspector; future copilot agent | Declarative node (`type` + `inputs`) that may carry refs (`@nodes.*`, `@inputs.*`) | Full: node definitions and the current spec |

The chat layer speaks only in tools; the orchestration layer only in nodes. A non-LLM translation layer (`build-from-events.ts`) converts captured tool calls into nodes mechanically at Save (§4). No LLM participates in extraction.

**Execution is unified; contracts are layered.** A node executor and its chat tool call the same underlying service: the extraction service for `sql` / `extract_dataset_by_sql`, and the sandbox invocation and result assembly for `code` / `run_code_in_sandbox`. They return the same result shape. Their input schemas are deliberately not one object:

- Node inputs may carry refs; tool arguments are always literal.
- Defaults differ by boundary: the chat SQL tool previews 5 rows by default (at most 200) for token economy, while the workflow uses the inline budget (§3.1).

**Field pieces are the single source of truth.** Identical fields are defined once as Zod pieces and assembled into both schemas; neither copies the other's definitions:

```ts
const sqlTextField = z.string().min(1).describe("...");
const dataSourceNameField = z.string().min(1).describe("...");

// Chat tool: literal arguments, LLM-preview defaults
const ExtractDatasetArgs = z.object({
  sql_text: sqlTextField,
  data_source_name: dataSourceNameField,
  dataset_name: z.string().min(1),
  row_limit: z.number().int().min(0).max(200).default(5),
  force_refresh: z.boolean().default(false),
});

// Workflow node inputs: ref-capable, engine-owned inline budget (no row_limit)
const SqlNodeInputs = z.object({
  sql_text: sqlTextField.describe("... @inputs.* value parameters (§5.3)"),
  data_source_name: dataSourceNameField,
  dataset_label: z.string().min(1).optional(),
}).strict();
```

**Node elevation policy.** A tool becomes a first-class declarative node type only if it takes part in data lineage (produces a dataset or `rows` that downstream nodes reference) or receives filter pushdown. Today those are `extract_dataset_by_sql` -> `sql`, `run_code_in_sandbox` -> `code`, chart tools -> `chart`, and `delegate_to_agent` -> `agent`. Every other tool becomes a generic `type: "tool"` node, and only when registered replayable; otherwise it is omitted (§4.1). This keeps the node vocabulary small and bounded by the data-lineage surface.

## 1. Scope, principles, and trust model

Nango is a single long-running Node process for personal use or a small, internally trusted team. Workflows are JSON DAGs behind artifacts, not a distributed execution platform. This proposal targets one reliable family of paths:

```text
------------- validated artifact filter inputs -------------
↓                                                          ↓
chat tools -> Save -> SQL --(Parquet dataset)-> optional Python --(small rows)->
----------------------(complete small rows)------------------↑
```

### 1.1 Data principles (normative)

1. **Large data never enters agent context.** The chat SQL tool returns a bounded preview (≤ 200 rows / 50 KB) plus `total_rows` and `row_schema`. The agent writes Python from the preview and schema; the Python runs against the full dataset.
2. **Large data never goes directly into a chart.** A chart receives a complete row array within the workflow inline budget (§3.1). A truncated preview is never presented as a complete refreshed chart.
3. **Large data flows between nodes by reference.** SQL materializes a full Parquet dataset in the team-shared cache; downstream code nodes read it by dataset reference. Full datasets do not travel through the workflow output bag, events, snapshots, or the browser.
4. **Save produces a replayable DAG; it does not invent filters.** Filter inputs are added afterwards by editing the spec (§4.5, §8).

### 1.2 Trust model and security layers

- **Datasets and the Parquet cache are shared across team users.** No owner IDs in cache keys, no per-user dataset handles. The sandbox is started with the system and mounts the shared cache read-only; mounts cannot change per run, and this proposal does not change that.
- The security boundary has three layers, and only these three:
  1. **Role/API gates** (`withSession` / `withEditor` / `withAdmin`, resource permissions) decide who can view, edit, and refresh artifacts.
  2. **Source query authorization:** every new extraction resolves the data source through the server-side data-source layer (credentials never leave it), checks it is in the caller's allowed set, and applies its read-only/table policy to the SQL that will actually run.
  3. **Sandbox capability reduction:** code guard checks, dedicated analysis agents with constrained prompts, pre-installed libraries only, no runtime installs, no network.
- **This proposal does not promise file-level confidentiality between trusted team users.**

## 2. Spec v2 (normative)

This section is the single source of truth for the JSON shape. Later sections refer to it and do not redefine fields.

### 2.1 Top-level shape

```json
{
  "version": 2, // spec format version (replaces per-node schema_version)
  "name": "Daily sales", // required
  "description": "", // optional
  "input_schema": { ... }, // optional; JSON Schema subset (§5.1). Definitions
  "nodes": [ ... ], // required, ≥ 1
  "outputs": { "option": "@nodes.chart_1.option" }, // required, ≥ 1; key ->
  "execution": { "max_parallelism": 3, "timeout_seconds": 120, "on_failure": "" }
}
```
`artifact.workflow_output_field` selects one key of `outputs` to render. Nothing else is stored in the spec: no resolved ids, no compile output (§2.5).

### 2.2 Common node fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string `^[a-z][a-z0-9_]{0,31}$` | yes | Unique, stable. Editing or deleting one node never renames others. Save derives ids from the tool and position (`sql_1`, `code_1`, `chart_1`); nobody (human or LLM) is required to invent names, but a human may rename a node in the Inspector (refs are rewritten in the same write). |
| `type` | `"sql"` \| `"code"` \| `"chart"` \| `"tool"` \| `"agent"` | yes | Tagged union discriminator |
| `description` | string | no | Human/agent-facing purpose |
| `inputs` | object | yes | Type-specific fields (§2.3). Kept from v1 to limit churn; unrelated to the workflow-level `input_schema` / `@inputs` refs despite the similar word. |
| `after` | string[] | no | Order-only dependencies. Rarely needed: data dependencies are inferred from refs (§2.5). |
| `retries` | { attempts, delay_seconds, backoff? } | no | |
| `timeout_seconds` | integer | no | Capped by config |

### 2.3 Node types ( `inputs` fields)

| Type | `inputs` | Runtime outputs |
|---|---|---|
| `sql` | `data_source_name` (string, literal), `sql_text` (string; `@inputs.*` value parameters from Phase 3, §5.3), `dataset_label` (string, literal, optional display label) | `dataset_name`: DatasetName (physical name), `total_rows`: int, `returned_rows`: int, `rows`: Rows, `row_schema`: RowSchema |
| `code` | `language` (`"python"` ; `"javascript"` without datasets), `code_text` (string, literal), `datasets` (array of whole-field refs to DatasetName), `params` (object; values are literals or whole-field refs) | CodeOutputEnvelope : `ok`, `rows`: Rows \| null, `row_count`, `row_schema`, `message`, `files`, `error`, `duration_ms` |
| `chart` | `renderer` (`"echarts"`), `config` (ECharts option template, literal, no data, ≤ 64 KB), `dataset` (whole-field ref to Rows, or array of ≥ 2 such refs for multi-dataset charts) | `option`: object |
| `tool` | `source` (`"builtin"` \| `"mcp:<server_id>"`), `name` (string), `arguments` (object; values literal or whole-field refs) | Per tool output schema. **Only tools registered as replayable (§4.1).** |
| `agent` | `name` (agent display name), `task` (string or whole-field ref), `context` (optional, same rules) | `result`: string. Executes only on explicit refresh or Save's first run, never on GET. Not required by SQL->Python->chart. |

### 2.4 References and the ref-carrier table

Reference grammar:
| Form | Meaning |
|---|---|
| `@nodes.<id>.<field>` | One top-level output field of an upstream node. No deep paths. |
| `@inputs.<key>` | One key of the resolved, validated input bag (§5.2) |
| `@context.<name>` | A fixed allow-list: `@context.now`, `@context.user_id` |

A ref is recognized **only when the whole string value is exactly one ref**; the resolved value keeps its JSON type. There is no embedded interpolation anywhere except `sql_text`, which has its own compiler (§5.3). A string that merely contains `@nodes.` (e.g. in code or chart text) is a literal.

**Ref-carrier table** (field paths are under the node's `inputs`). A ref anywhere not listed here is a lint error (`SPEC_REF_NOT_ALLOWED`).

| Node.field | Allowed |
|---|---|
| `sql.sql_text` | `@inputs.<key>` value parameters only, compiled by §5.3. **Until Phase 3 ships, any `@inputs` token here is a lint error (`SQL_PARAMS_NOT_ENABLED`).** `@nodes.*` / `@context.*` are always rejected: so it is never sent to a database as text. |
| `sql.data_source_name`, `sql.dataset_label` | **Literals only.** Switching sources means editing the spec (and passing source authorization), never submitting a filter. |
| `code.datasets[i]` | `@nodes.<sql_id>.dataset_name` |
| `code.params.<k>` | Literal, or whole-field `@inputs.*` / `@nodes.*` / `@context.*` |
| `code.code_text`, `chart.config`, `chart.renderer` | Literals only; never scanned |
| `chart.dataset` (or each element) | `@nodes.<id>.rows` (type `Rows`) |
| `tool.arguments.<k>`, `agent.task`, `agent.context` | Literal, or whole-field ref |
| `outputs.<k>` | `@nodes.<id>.<field>` |

### 2.5 Stored form, compile, and lint

- `workflow.spec` persists the authoring form above, and only it. Humans (Inspector), agents (future), and `build-from-events` all read and write this same shape. Compile output is never persisted; there is no separate LLM-emit vs canonical schema and no stored lock map.
- `compile(spec, deps)` runs at **every write and every execution** and produces an in-memory CompiledWorkflow:
  1. Zod shape parse (strict, no passthrough).
  2. Resolve names against current catalogs: `data_source_name` within the caller's allowed data sources, agent by display name, tool by source + name. Data-source names cannot be changed after creation (the `data-source` PATCH API rejects `name`), so the name is a stable key. A deleted source fails with `DATA_SOURCE_NOT_FOUND`; a source recreated under the same name is used, per the admin's intent. A renamed or deleted agent fails with `AGENT_NOT_FOUND`, fixed by picking the agent again in the Inspector.
  3. Infer data edges from the ref carriers (§2.4). Effective deps = inferred ∪ `after`, sorted.
  4. Validate unknown nodes/fields, output-field types (registry: `rows`: `Rows`, `dataset_name`: `DatasetName`, `option`: `object`, ...), reachability, cycles, ref-carrier rules, SQL template rules (§5.3), size caps, replayability.
- `lint(spec)` **returns all issues rather than throwing on the first**: `{ severity, code, path, node_id, message, hint }`, where `path` is a JSON Pointer (e.g. `/nodes/1/inputs/sql_text`). Three severities:

| Severity | Effect | Examples |
|---|---|---|
| `error` | Blocks the write | `Unknown ref`, `cycle`, `SPEC_REF_NOT_ALLOWED`, `SQL_PARAMS_NOT_ENABLED`, `DATA_SOURCE_NOT_FOUND` |
| `not_refreshable` | Write succeeds; sets `artifact.refreshable = false` **if and only if** the issue falls within the ancestor closure of `artifact.workflow_output_field` (§6). If present only in an unrelated branch, surfaces as a spec warning without disabling refresh for the selected output; message shown in the UI | Chart bound to truncated SQL rows exceeding inline budget (§4.3), data from an omitted non-replayable invocation, `HARDCODED_DATASET_PATH` |
| `warning` | Informational only | Unused node, ambiguous Strategy Z+ match kept literal, `not_refreshable` issue in an unselected branch |

The Inspector and a future agent editor fix every issue in one pass.

### 2.6 Examples

Ids below are hand-picked for readability; a chat Save produces `sql_1`, `chart_1`, and so on.

**A. Small SQL result charted directly (24 daily totals; SQL does the aggregation):**
```json
{
  "version": 2,
  "name": "Daily sales (last 30 days)",
  "nodes": [
    {
      "id": "sales", "type": "sql",
      "inputs": { "data_source_name": "sales_pg",
                  "sql_text": "SELECT day, SUM(amount) AS total FROM orders WHERE day >= current_date - 30 GROUP BY 1" }
    },
    {
      "id": "chart", "type": "chart",
      "inputs": { "renderer": "echarts",
                  "config": { "xAxis": { "type": "category" }, "yAxis": { "type": "value" },
                              "series": [{ "type": "line", "encode": { "x": "day", "y": "total" } }] },
                  "dataset": "@nodes.sales.rows" }
    }
  ],
  "outputs": { "option": "@nodes.chart.option" }
}
```
Compiled: chart deps `[sales]`. At run, chart requires `sales.returned_rows === sales.total_rows`, which holds because 24 ≤ the inline budget.

**B. Large SQL result -> Python aggregation -> chart (500,000 raw rows):**
```json
{
  "version": 2,
  "name": "Order count by weekday",
  "nodes": [
    {
      "id": "orders", "type": "sql",
      "inputs": { "data_source_name": "sales_pg",
                  "sql_text": "SELECT created_at, amount FROM orders WHERE created_at >= DATE '2025-01-01'" }
    },
    {
      "id": "agg", "type": "code",
      "inputs": { "language": "python",
                  "datasets": ["@nodes.orders.dataset_name"],
                  "params": { "min_amount": 10 },
                  "code_text": "import duckdb, json\npath = f'./tmp/data/{datasets[0]}/**/*.parquet'\nres = duckdb.query(f\"SELECT dayofweek(created_at) AS weekday, count(*) AS n FROM read_parquet('{path}') WHERE amount >= {params['min_amount']} GROUP BY 1\").df()\nprint(json.dumps({'rows': res.to_dict('records')}))" }
    },
    {
      "id": "chart", "type": "chart",
      "inputs": { "renderer": "echarts",
                  "config": { "xAxis": { "type": "category" }, "yAxis": { "type": "value" },
                              "series": [{ "type": "bar", "encode": { "x": "weekday", "y": "n" } }] },
                  "dataset": "@nodes.agg.rows" }
    }
  ],
  "outputs": { "option": "@nodes.chart.option" }
}
```
`orders.rows` is only a preview here and nothing references it. Python reads the full Parquet via `datasets[0]`, never a hard-coded path.

**C. Multiple sources, multi-step analysis, several charts:**
```json
{
  "version": 2,
  "name": "Revenue vs. support load",
  "nodes": [
    { "id": "revenue", "type": "sql",
      "inputs": { "data_source_name": "sales_pg",
                  "sql_text": "SELECT region, day, amount FROM orders WHERE day >= DATE '2025-01-01'" } },
    { "id": "tickets", "type": "sql",
      "inputs": { "data_source_name": "support_vertica",
                  "sql_text": "SELECT region, day, count(*) AS tickets FROM tickets WHERE day >= '2025-01-01' GROUP BY 1, 2" } },
    { "id": "joined", "type": "code",
      "inputs": { "language": "python",
                  "datasets": ["@nodes.revenue.dataset_name", "@nodes.tickets.dataset_name"],
                  "code_text": "# join both datasets by region/day, emit per-region weekly trend and a global pie chart..." } },
    { "id": "by_region", "type": "code",
      "inputs": { "language": "python",
                  "datasets": ["@nodes.revenue.dataset_name"],
                  "code_text": "# total revenue per region\n..." } },
    { "id": "trend_chart", "type": "chart",
      "inputs": { "renderer": "echarts",
                  "config": { "xAxis": { "type": "category" }, "yAxis": [{ "type": "value" }, { "type": "value" }],
                              "series": [{ "type": "line", "encode": { "x": "week", "y": "revenue" }, "yAxisIndex": 0 },
                                         { "type": "bar", "yAxisIndex": 1, "encode": { "x": "week", "y": "tickets" } }] },
                  "dataset": "@nodes.joined.rows" } },
    { "id": "region_chart", "type": "chart",
      "inputs": { "renderer": "echarts",
                  "config": { "series": [{ "type": "pie", "encode": { "itemName": "region", "value": "revenue" } }] },
                  "dataset": "@nodes.by_region.rows" } }
  ],
  "outputs": { "trend": "@nodes.trend_chart.option", "regions": "@nodes.region_chart.option" }
}
```
`revenue` and `tickets` run in parallel, and both `code` nodes read the same shared Parquet dataset. An artifact renders one `workflow_output_field` (§10, D1), and an artifact execution runs only that output's ancestor closure (§6). An artifact bound to `trend` runs `revenue`, `tickets`, `joined`, `trend_chart`, and never touches `by_region` / `region_chart`.

**D. Example A with a filter added after Save (Phase 3; via the Inspector or a future agent):**
```json
{
  "version": 2,
  "name": "Daily sales",
  "input_schema": {
    "type": "object",
    "properties": {
      "start_date": { "type": "string", "format": "date", "title": "Start date" },
      "region": { "type": "string", "null": true, "default": null, "enum": ["east", "west"] }
    },
    "required": ["start_date"]
  },
  "nodes": [
    {
      "id": "sales", "type": "sql",
      "inputs": { "data_source_name": "sales_pg",
                  "sql_text": "SELECT day, SUM(amount) AS total FROM orders WHERE day >= @inputs.start_date AND (@inputs.region IS NULL OR region = @inputs.region) GROUP BY 1" }
    },
    {
      "id": "chart", "type": "chart",
      "inputs": { "renderer": "echarts",
                  "config": { "xAxis": { "type": "category" }, "yAxis": { "type": "value" },
                              "series": [{ "type": "line", "encode": { "x": "day", "y": "total" } }] },
                  "dataset": "@nodes.sales.rows" }
    }
  ],
  "outputs": { "option": "@nodes.chart.option" }
}
```
Compiled `sales.sql_text` for a binding provider: `... WHERE day >= $1 AND ($2 IS NULL OR region = $2) ...` with typed values `["2026-03-01", "east"]`. A repeated key reuses its binding (§5.3).

## 3. Data paths and budgets

### 3.1 Two separate budgets

| Budget | Consumer | Default (config key) | Where enforced |
|---|---|---|---|
| LLM preview | Agent context in chat | 5 rows default, ≤ 200 rows / 50 KB (`datasource.preview.max_rows`, `datasource.preview.max_bytes`) | Chat `extract_dataset_by_sql` only |
| Workflow inline | Chart rendering, snapshot, API response | ≤ 1000 rows / 1 MB serialized (`workflow.inline_max_rows`, `workflow.inline_max_bytes`; replaces `sql.inline_max_rows` / unenforced `sql.inline_max_bytes_mb`) | Workflow SQL node `rows`, code node `rows` consumed by a chart, chart `option` |

The budgets are independent. Raising the workflow inline budget must not raise what the LLM sees. The workflow SQL node therefore calls the shared extraction service with its own inline limit instead of invoking the chat tool, which clamps to the LLM preview cap. Both paths share source resolution, authorization, policy, the cache, and result assembly.

### 3.2 SQL output and chart completeness

- `dataset_name` names the full Parquet result in the shared cache. `rows` is at most the workflow inline budget. `returned_rows === total_rows` is the only proof that `rows` is complete. `total_rows ≤ limit` alone is not enough, because the byte cap can truncate.
- A chart whose `dataset` IS `@nodes.<sql_id>.rows` checks the referenced SQL node's own output bag at run time: incomplete -> `CHART_DATA_INCOMPLETE` with the hint "aggregate in SQL or add a Python node". For a multi-dataset chart, **every** element is checked, and any incomplete or oversized element fails the chart. Code `rows` count as complete but must fit the inline budget (`CHART_DATA_TOO_LARGE` otherwise). Referencing `dataset_name` from `chart.dataset` is a type error at compile.
- The check repeats on every refresh, because filter values change cardinality. There is no "sample-only chart" mode: incomplete data fails.

### 3.3 Python input bridge

A `code` node receives three bindings through the single existing `_PARAMS_` JSON transport, so they never merge or collide:

| Binding | Content |
|---|---|
| `inputs` | The run's validated input bag (§5.2), injected automatically |
| `params` | The node's resolved `params` |
| `datasets` | Resolved physical dataset names, in `datasets` order |

Python reads `./tmp/data/{datasets[i]}/**/*.parquet` under the fixed shared mount. A hard-coded dataset path or name in `code_text` is a `not_refreshable` lint issue (`HARDCODED_DATASET_PATH`), because the physical directory a node reads can differ between runs (§7). Align the chat `run_code_in_sandbox` tool to the same bridge: it currently declares `params` but does not forward them. Code output must fit the inline budget when a chart consumes it; aggregate further otherwise.

### 3.4 Events and snapshots stay small

- `workflow_node_completed` events persist a summary, not the full output bag: `row_counts`, `dataset_name`, `row_schema`, the first ≤ 20 `rows`, `duration_ms`, `cached`. Today the recorder writes the whole engine event including full `outputs`, which becomes unbounded as soon as rows grow.
- Artifact snapshots store the rendered output (e.g. the merged ECharts `option`, bounded by §3.1) in `snapshot`, the inputs used in `snapshot_inputs`, and the run time in `snapshot_at` (§6).
- SQL node events record the compiled SQL and bound parameter values for debugging ("why did this filter return nothing"). These values are as sensitive as the existing run forensics timeline: visible to admins in run detail, never copied into snapshots.

## 4. Chat -> workflow (Save)

### 4.1 Tool-to-node mapping

| Captured tool | Saved as | Replayable |
|---|---|---|
| `extract_dataset_by_sql` | `sql` | yes |
| `run_code_in_sandbox` | `code` | yes |
| `generate_echarts_config` | `chart` (never re-called on refresh) | yes |
| `delegate_to_agent` | `agent` | yes (refresh only) |
| `generate_html_page`, `generate_bento_slides` (+ `edit_bento_slides` merge) | Current save/snapshot path; the creator becomes a `tool` node | yes: their `execute` only validates and echoes its arguments, so a refresh replays the saved args and runs no browser or data query. HTML that should depend on SQL data would need a real data node; it is not silently re-echoed as if refreshed. |
| Screenshot / image tools | Snapshot only; no node | no (browser side effects) |
| Other tools / MCP tools | `tool` **only if the tool registry marks it** `replayable: true` (read-only, idempotent). Default `false`. | per flag |

Non-replayable invocations are **omitted from the DAG**, and their outputs stay literal in downstream nodes. If an artifact's data depends on an omitted invocation, the artifact is saved with a `not_refreshable` issue (§4.3) rather than failing or re-running side effects.

### 4.2 Binding rules

1. **Do not copy the chat** `row_limit` **into the SQL node.** The chat value (often 5) is an LLM-preview setting. The workflow uses the inline budget. The current `build-from-events` copies it, and that must be removed.
2. Chart data binding: if the chart call carries `dataset_id` (the tool and prompt already ask for it), bind `chart.inputs.dataset` to `@nodes.<sql_node_whose_captured_dataset_name_matches>.rows`. This is deterministic. Only when it is absent, fall back to the existing Strategy Z+ deep-equal match of `option.dataset.source` against upstream `rows`. On a match, strip `dataset.source` from `config`.
3. Code `datasets` elements that uniquely match an upstream captured `dataset_name` become `@nodes.<id>.dataset_name` (Strategy Z+, unchanged). Ambiguous values stay literal and are reported in the lineage report.
4. The captured chat `dataset_name` becomes the SQL node's optional `dataset_label`.
5. Node ids are derived from the tool and position (`sql_1`, `code_1`, `chart_1`) and are never renumbered later.
6. **Dead-node pruning via backward reachability (save-time slicing).** The save pipeline must produce a clean, minimal DAG. After Strategy Z+ and deterministic `dataset_id` bindings reconstruct `@nodes.*` references, the pipeline performs a backward reachability traversal from the artifact-creating terminal node (e.g. `chart_1`) through all inferred data references to compute its exact ancestor set (`RequiredAncestorNodeIds`). Any successful tool invocation captured earlier in the thread that does not contribute to this ancestor closure (such as exploratory dead-end queries, unrelated tool calls from chit-chat, or abandoned intermediate attempts) is **silently pruned from `nodes` before persisting**. The pruned invocation IDs are recorded in `lineageReport.pruned_invocations` for forensic audit. This guarantees that the persisted workflow contains zero dangling/orphan nodes and triggers zero `Unused node` lint warnings.

### 4.3 Direct SQL -> chart cases at Save

The agent may return up to 200 rows in chat. It reports `total_rows`, and it should say so (reply or chart title) when the chat chart is partial.

| Captured chat result | Save outcome |
|---|---|
| `returned_rows === total_rows` (≤ 200) | Bind chart to SQL `rows`. Refreshable. |
| Truncated in chat, `total_rows` ≤ workflow inline budget (e.g. 350 total, 200 shown) | Bind chart to SQL `rows`. Refreshable. The first run (§4.4) produces the *complete* chart, better than the chat preview. The Save response notes that the saved chart shows all rows. |
| `total_rows` > workflow inline budget | Store the chat-captured rendered chart in `artifact.snapshot` (viewable immediately), while keeping `chart.inputs.config` as a pure data-free template (preventing spec bloat and avoiding `CHART_CONFIG_TOO_LARGE`). Save succeeds with a `not_refreshable` issue on the chart node: "result exceeds chart budget; aggregate in SQL or add a Python step". |
| Chart data from Python `rows` | Bind to `@nodes.<code_id>.rows`. Refreshable if the code uses `datasets[i]` (no hard-coded path) and output fits the budget. |

### 4.4 Save = compile + first run

Save runs `compile` + `lint` on the pruned minimal spec, persists the authoring spec, then executes the workflow once with `force_refresh = false` (as `saveArtifact` already does today). Because cache lookup is by query identity (§7), the SQL nodes hit the Parquet the chat just wrote. The first run does not query the source unless the chat dataset expired or was replaced. That first run's output becomes the initial snapshot (with `snapshot_inputs` and `snapshot_at`), so the saved artifact shows workflow-produced data rather than LLM-copied data.

If the first run fails, the artifact is **still saved** with the chat-captured snapshot, and the failure is persisted in `artifact.last_run_error` ( `{ code, message, node_id, at }` ). The UI shows it until a later refresh succeeds, so the user can fix the spec in the Inspector (S10, D3). Today `saveArtifact` already runs a non-fatal first execution, but `executeWorkflow` turns a `WorkflowError` into `null` and the failure only reaches a server log. Making it visible is the change.

`artifact.refreshable` is recomputed on every write: `false` exactly when `lint` reports any `not_refreshable` issue **within the ancestor closure of `artifact.workflow_output_field`** (§2.5, §6). Those messages are returned with the save response and shown on the artifact. Issues outside the closure do not disable refresh.

### 4.5 Save does not create filters

A chat-derived spec has baked-in SQL and an empty `input_schema`, and the Filter panel stays collapsed. Filters come later (Phase 3), from the Inspector (or a future agent) adding `input_schema` properties and rewriting `sql_text` with `@inputs.*` parameters. A "promote literal to input" action in the Inspector is the intended shortcut. Acceptance tests for filters use such edited specs, not raw chat saves.

## 5. Inputs and filters

### 5.1 `input_schema` subset

- **Top level type:** `"object"`, named `properties`, optional top-level `required`.
- **Property type:** `string`, `number`, `boolean`, or array of strings/numbers (with `items.type`, `maxItems` required, optional `uniqueItems`). `format: "date"` is a string format; a date range is two date properties.
- **Nullable uses `type: ["<base>", "null"]`** with explicit `default: null`. Optional `metadata`: `enum`, `title`, `description`, supported UI hints (presentation only, never value types).
- **Defaults must match their type.** Reject unknown keys, mismatched types, invalid dates, non-finite numbers, and oversized strings/arrays. No `passthrough()`. The schema itself is validated at compile.

### 5.2 Value resolution (one input bag per run)

- `input_schema` holds definitions only. `value` is not a spec field.
- **Refresh request:** `{ "inputs": { ... } }`. Resolution: request value > schema default > missing-required error, validated server-side on every request. The frontend form is not a validation boundary.
- The inputs used by a run are stored with its snapshot (`artifact.snapshot_inputs`). The Filter panel pre-fills from the current snapshot's inputs and Reset restores schema defaults. Saved values therefore never bypass validation: They are just a previous validated request replayed from the UI.

### 5.3 SQL value-parameter compiler (Phase 3)

`sql_text` never passes through generic ref resolution. Detecting "unquoted" tokens requires lexing, so the compiler substitutes first and lets the parser decide, failing closed:

1. **Substitute.** Replace every `@inputs.<key>` occurrence (including ones mistakenly inside quotes or comments) with a unique sentinel placeholder in a form the provider's parser (`node-sql-parser`, already used by `policy.ts`) recognizes as a parameter node. Every key must exist in `input_schema`. Record the number of substitutions.
2. **Parse** the substituted SQL with the provider dialect. A parse failure rejects the template.
3. **Count check.** Collect parameter nodes from the AST. Their count must equal the substitution count. A token that was inside a string literal (`'@inputs.x'`) or a comment does not appear as a parameter node, so a mismatch rejects the template.
4. **Position check.** Every parameter node must be in a value-expression position. Reject identifiers, table/function names, LIMIT / ORDER BY targets, or any other non-value slot.
5. **Bind.** Emit the provider's real placeholders (`$n` / `?`) or adapter-rendered literals, with typed values: strings (including ISO dates), finite numbers, booleans, explicit null. A repeated key reuses one binding. Nullable optional filters use `(@inputs.k IS NULL OR col = @inputs.k)`, never `= NULL`.
6. **Arrays.** Only `col IN (@inputs.arr)` is supported. A non-empty array expands to one placeholder per element: `col IN ($1, $2, ...)`. When the resolved input array is empty, the compiler rewrites the **entire** `col IN (@inputs.arr)` predicate in the AST into a constant-false predicate `(1=0)`, never invalid SQL like `col IN ()` or type-mismatched `col IN (1=0)`. `NOT IN` and other array uses are rejected in v1.
7. **Policy.** Run the source's read-only/table policy on the SQL that will execute, at extraction time.

If a dialect cannot be parsed reliably, that provider does not support filter parameters yet; its unparameterized extraction keeps working. Providers that cannot bind (the DuckDB-extension `COPY` path and current Vertica adapter reject `ExtractInput.params`) need an adapter-owned, value-position-only literal renderer, tested for quoting/arrays/null, before filters are enabled for them. Changing a TypeScript type is not an implementation. Until this compiler ships, `@inputs` in `sql_text` is a lint error (§2.4).

### 5.4 Dynamic dropdown options (follow-up)

Static `enum` ships first. The follow-up `options_source` design is preserved:

```json
{
  "type": ["string", "null"], "title": "Initiator", "default": null,
  "options_source": { "type": "sql", "data_source_name": "nango-db",
                    "sql_text": "SELECT DISTINCT initiator AS label, initiator AS value FROM entity_run" }
}
```
A future `GET /api/artifacts/[id]/filters` uses `withSession` plus the artifact's read check, runs the declared SQL with the same source authorization/policy, enforces row/byte/time bounds, returns `{ label, value }[]`, and never accepts client SQL. A submitted value must still pass the declared type/enum validation.

### 5.5 Filter UI

Keep the existing View/Workflow switch, the chart preview, the graph, and the horizontally resizable chart/Filter layout (Filter collapsed when there are no properties). RJSF with the shadcn theme renders `input_schema`. Apply sends `POST /api/artifacts/[id]/refresh { inputs }`, which executes the workflow against live source data and updates the in-session display **without automatically overwriting the persisted snapshot**. If the user wishes to save the refreshed result as the baseline, they explicitly click "Save as snapshot" (triggering `POST /api/artifacts/[id]/snapshot { inputs }`). SQL is the pushdown point, Python receives the same `inputs`, and ECharts must not silently re-filter the same field (presentation-only transforms such as sorting remain fine).

## 6. Run semantics and operation contracts

The engine strictly decouples **Save**, **Refresh**, and **Save Snapshot** into distinct contracts, rather than conflating source extraction freshness, event recording, and snapshot persistence behind a single overloaded `forceFresh` flag:

| Action | Reason / Mode | Data Freshness | Executes workflow | Persists |
|---|---|---|---|---|
| `GET /api/artifacts/[id]` | `view` | `from_storage` | **No.** Returns stored `snapshot`, `snapshot_inputs`, `snapshot_at`, `last_run_error`, closure-scoped `refreshable`, and `spec`. | Nothing |
| `POST /[id]/refresh { inputs }` | `refresh` | `force_fresh` (re-queries source SQL; bypasses Parquet cache hit) | **Yes**, evaluates only the ancestor closure of `artifact.workflow_output_field`. | **Does NOT save snapshot.** Writes/updates `last_run_error` on failure, clears `last_run_error` on success. Returns fresh rendered `data` and `executedAt` to the client session. |
| `POST /[id]/snapshot { inputs }` | `snapshot` | `from_session` | **No re-execution needed** when persisting the verified in-memory session result; or controlled verification run. | Persists `snapshot`, `snapshot_inputs`, `snapshot_at`. Triggered **only** when user explicitly clicks "Save as snapshot". |
| Save (§4.4) | `save` | `allow_cache` (hits chat-extracted Parquet slot) | **Yes**, once for initial verification. | Persists authoring `spec`, initial `snapshot`, `snapshot_inputs`, `snapshot_at` (or `last_run_error`). |

### 6.1 Decoupled Execution Parameters

In code, the adapter interface (`executeWorkflow`) decouples the overloaded flags into explicit dimensions:
1. `reason`: `"save" | "refresh" | "snapshot"` (drives event timeline labeling and audit logs).
2. `forceFresh`: `boolean` (when `true`, SQL extraction re-queries the database source; `false` allows Parquet identity cache hits). **Refresh requests always specify `forceFresh: true`**.
3. `persistSnapshot`: `boolean` (only `true` on Save and Save Snapshot; **never** on Refresh).
4. `subAgentPolicy`: `"dispatch" | "stub"` (agents execute on explicit user refresh; stubbed during unattended initial validations).

### 6.2 Scope of Execution & Refreshability

- An artifact execution evaluates **only the ancestor closure** of the node referenced by the artifact's `workflow_output_field`. Unrelated branches (another chart, its code nodes) are neither executed nor able to fail the run.
- `artifact.refreshable` is computed strictly against the **same ancestor closure**: if a not-refreshable issue (such as hardcoded paths or untracked tool dependencies) exists only in an unselected branch, it produces a workflow warning but does **not** mark the artifact as unrefreshable.
- A failed refresh returns an actionable error (node id, error code, hint), writes `last_run_error`, and keeps the last snapshot intact. Missing data is never treated as success. A successful refresh clears `last_run_error`.
- Today GET executes the workflow when `view_mode = 'live'`, or when the snapshot is NULL. Both paths are removed (S10, D2). `artifact.view_mode` is dropped. The UI's "Snapshot / Live" toggle becomes purely client-side session state: it displays the stored snapshot, or the latest refresh result of this session (unsaved until the user clicks "Save as snapshot"). An artifact without a snapshot shows an empty state with a Refresh button.

Artifact columns after this change: `snapshot` (rendered output, unchanged shape), `snapshot_inputs` jsonb (new), `snapshot_at`, `last_run_error` jsonb (new), `refreshable` boolean NOT NULL DEFAULT true (new). `view_mode` is dropped.

### 6.3 Terminal Output Contract Verification (ZEN Engine pattern)

Beyond graph-level topological reachability and JSON syntax validity, the engine enforces a strict **Terminal Output Contract** on the selected `artifact.workflow_output_field` before declaring any execution successful:
1. **Chart outputs**: The resolved `option` object must be a non-null, valid renderer template (with valid series/axes), and every bound dataset must prove completeness (`returned_rows === total_rows`). Truncated previews or malformed option structures fail the run immediately with `CHART_DATA_INCOMPLETE` or `OUTPUT_SCHEMA_MISMATCH`.
2. **Code / Tool outputs**: The emitted payload must strictly conform to its declared runtime envelope or `output_schema`.
3. **Failure semantics**: An execution where intermediate nodes ran with exit code 0 but the terminal output field fails this contract is marked failed, writes `last_run_error`, and keeps the previous snapshot. It never renders a blank canvas or displays partial data under a "Refresh successful" badge.

## 7. Shared Parquet cache

Keep the local cache, TTL (24 h default), boot purge, source-deletion purge, and the fixed read-only sandbox mount. Correctness fixes only:

1. **Identity-based lookup (Phase 1).** A dataset's identity is `(data_source_id, SQL text exactly as executed, bound parameter values)`. The directory name is only a storage key, `ds_<hash(identity)>`.
   - An in-process index `Map<identity, directory>` is updated on every commit, slot reassignment, and purge. It starts empty at boot, which is correct because boot purges the cache.
   - The chat tool keeps its contract: it writes to the agent-named slot directory and still answers "same name + same SQL" as a hit (now also requiring the same `data_source_id`). Each chat write also registers its identity in the index.
   - Workflow SQL nodes look up by identity. A hit returns whichever directory holds it, often the chat slot just written, so Save's first run does not re-query the source. A miss writes a new directory named `ds_<hash(identity)>`; workflows never write into agent-named chat slots.
   - The same label and SQL on another source can never hit the wrong Parquet, and different filter values never share or overwrite a directory.
2. **Hits.** A hit requires identity match, fresh TTL, and `no force_refresh`. A hit is not a source query, so it does not re-run the table policy; the Parquet is a snapshot artifact, and the next miss applies the current policy. This matches current behavior and is now stated explicitly. New extractions always go through source authorization and policy (§1.2). The sidecar stores `row_schema` so hits return the same columns as fresh runs (Phase 2; today hits return `columns: []`).
3. **Replacement without breaking readers (Phase 2).** Two events replace a directory's content: a forced refresh of an identity whose directory already exists, and a chat slot reassignment (same name, different SQL). Both write to a temp directory, swap, and delete the old directory only when no in-flight run in this process holds it (in-process refcount, taken when a code node is dispatched with that dataset). This replaces today's `rm -rf <final> && rename(tmp, final)` in `commitWriteSlot`. No `asset/version` object model and no GC service.
4. The engine's optional JSON node cache (`engine/cache.ts`) stays unwired.

## 8. Editing paths

Every write goes through `compile + lint` (§2.5): `build-from-events`, `PATCH /api/artifacts/[id]/nodes/[nodeId]`, and any future agent editor. Clients send the authoring form only. Today `updateArtifact` / `updateWorkflowNode` only run `validate` and write the client-supplied canonical node directly; they must switch to authoring-form input plus compile. Deleting a node that is still referenced is an error issue pointing at the referring fields. Concurrent node edits keep the existing row lock.

**Explicit field binding in Inspector (Windmill pattern).** While `build-from-events` mechanically infers `@nodes.*` references during Save (§4.2), human editing in the Inspector must not require hand-typing `@nodes.<id>.<field>` ref strings. Ref-carrier fields (e.g. `chart.inputs.dataset`, `code.inputs.datasets`, `code.inputs.params.*`) render a dual-mode control: toggle between "Literal value" and "Upstream node output" (a dropdown populated with available upstream nodes and their compatible output fields, such as `sales (sql_1) -> rows`). Renaming or rewiring upstream dependencies updates the declarative authoring spec cleanly without syntax typos.

**Future agent editing (design kept, implementation deferred).** A copilot in the artifact view receives the authoring spec, the available data sources and their schema, and the `input_schema`. It proposes a full authoring spec or changed nodes, then iterates on `lint` issues. It never writes resolved ids or compile output. The preview reuses the existing draft pattern (`useCopilotDraft`) with an explicit user confirm before saving.

## 9. Execution plan

Priorities: **P0** must land together to replace v1 (the v1 engine and specs are deleted, so there is no mixed state); **P1** data correctness that must precede filters; **P2** filters; **P3** deferred.

### Phase 0 (Completed): Early-Bird Groundwork & Resilience

The following high-impact improvements were identified during review as standalone capabilities and safety barriers that could be delivered ahead of the Phase 1 spec rewrite without architectural entanglement. All items have been fully implemented, reviewed across multiple rounds (P1–P8 hardening), and verified with comprehensive unit test coverage.

| Item | Focus & Delivered Contract | Key Files Modified | Hardening & Review Outcomes (P1–P8) | Verification Status |
|---|---|---|---|---|
| **P0-0** (D14) | **Backward Reachability Dead-Node Pruning**<br>Traverses transitive `depends_on` from terminal output nodes & artifact creator, discarding exploratory dead-ends and chit-chat tool calls. | `src/lib/workflows/build-from-events.ts` | • **P1:** Added 3-color DFS active-call-stack cycle detection with structured `console.warn` & dependency edge skipping.<br>• **P2:** Replaced $O(N)$ `queue.shift()` with recursive DFS ($O(V+E)$ optimal).<br>• **P3:** Validated terminal node existence before traversal and simplified dead fallback branches. | ✅ `tests/unit/lib/workflows/build-from-events.test.ts` (78 tests passed) |
| **P0-1** (D12) | **DataSource Cache Isolation**<br>Binds cache lookup strictly to `(data_source_id, sql_text)`. Prevents cross-database data leakage when queries match across different sources. | `src/lib/data-sources/runtime-tools.ts` | • Validates `status.meta.dataSourceId === resolved.id` for cache hits.<br>• Logs explicit audit events distinguishing SQL changes from data-source ID switches. | ✅ `tests/unit/lib/data-sources/runtime-tools.test.ts` (104 tests passed) |
| **P0-2** (D2, D6) | **Snapshot Preservation & Config Integrity**<br>Ensures snapshot saves renderable data directly without re-execution. Strictly protects `config` from slide document leakage on non-slide artifacts. | `src/components/main-panels/ArtifactDetail.tsx`<br>`src/lib/artifacts/save-snapshot.ts`<br>`src/lib/artifacts/bundle.ts` | • Non-slide artifacts never write to `config.doc`.<br>• `preferSnapshot: true` skips redundant executions.<br>• **P4:** `updateWorkflowInputValues` warns on schema-mismatched keys and surfaces `ignoredInputKeys` on the bundle. | ✅ `tests/unit/lib/artifacts/save-snapshot.test.ts` (7 tests passed) |
| **P0-3** (§1.9, §3.4) | **Bounded Event Summaries**<br>Caps oversized result sets before writing to `entity_run_event`, preventing append-only audit DB bloat. | `src/lib/artifacts/workflow-run-recorder.ts` | • **P5:** Head-tail string truncation (`truncateHeadTail`) preserving first 500 + last 500 characters so terminal stack traces are never lost.<br>• **P6:** Bounded recursive object/array summarizer enforcing `MAX_EVENT_NESTING_DEPTH = 3` and capping nested arrays to 20 rows. | ✅ `tests/unit/lib/artifacts/workflow-run-recorder.test.ts` (19 tests passed) |
| **P0-4** (§2.3) | **Sandbox Params Transport & Guardrails**<br>Serializes `params` as `__PARAMS__` JSON payload alongside scalar env vars for sandbox code execution. | `src/lib/sandbox/runtime-tools.ts`<br>`src/lib/sandbox/adapters/service/adapter.server.ts` | • **P7:** Python & JS preambles unconditionally declare `params = {}` / `let params = {};` so unparameterized scripts never throw `NameError`/`ReferenceError`.<br>• **P8:** `RunInSandboxArgs` validates and rejects reserved key `__PARAMS__` to prevent payload corruption. | ✅ `tests/unit/lib/sandbox/` (44 tests passed) |
| **P0-5** | **Build & Compiler Warning Hygiene**<br>Resolved dynamic filesystem access warnings in Turbopack. | `src/lib/playwright/storage.server.ts` | • Added `/*turbopackIgnore: true*/` annotations.<br>• Build warnings reduced to 0. | ✅ `pnpm build` (0 warnings, 59 pages generated) |

Phase 1 is an engine rewrite (compile/lint, string ids, whole-field refs, compiled graph), not a small prerequisite of filters. It keeps the v1 `inputs` wrapper and field names wherever semantics are unchanged to limit churn. Work on a branch. Each step ships with unit tests and keeps `pnpm check-types` green, but Phase 1 merges as one unit.

### Phase 1 (P0): Spec v2 end to end

Goal: the SQL -> chart and SQL -> Python -> chart chat paths save as v2 workflows without re-querying the source, show workflow-produced snapshots, refresh correctly within the inline budget, and are editable through compile.

| Step | Tasks | Depends on | Done when |
|---|---|---|---|
| 1.1 Spec v2 schema | Zod schemas for §2.1-2.3 (strict). Registry output types (`Rows`, `DatasetName`, `RowSchema`, `option`, `CodeOutputEnvelope`). Delete the LLM-emit/canonical split, canonical-only fields, and v1 schemas. | - | Examples A-C in §2.6 parse and run end-to-end. Example D parses syntactically, but its execution is deferred to Phase 3 (as `@inputs` in SQL is guarded by `SQL_PARAMS_NOT_ENABLED` in Phase 1). v1-only shapes (numeric ids, `schema_version`, `data_source_id`, `@workflow.*`, `row_limit`) are rejected. |
| 1.2 compile + lint | Pure functions with injected catalogs: name resolution within allowed data sources, agents, tools; ref-carrier rules (§2.4) including `SQL_PARAMS_NOT_ENABLED`; inferred deps ∪ `after`; cycle/reachability/type checks; size caps; replayability. Issue list with JSON pointers and the three severities. | 1.1 | Unit tests cover every §2.4 row, multiple issues returned at once, `@inputs` in `data_source_name` / `sql_text` rejected, deleted source -> `DATA_SOURCE_NOT_FOUND`, `not_refreshable` issues do not block. |
| 1.3 Engine on compiled graph | Scheduler over string ids and compiled deps, restricted to the selected output's ancestor closure (§6). Whole-field ref resolution only (remove embedded interpolation from `execution-context.ts`). Node executors read v2 `inputs`. Chart enforces completeness/size per dataset element (§3.2). | 1.2 | Engine tests for A-C with stubbed deps. `CHART_DATA_INCOMPLETE` / `CHART_DATA_TOO_LARGE` raised, including one bad element of a multi-dataset chart. Selecting `trend` in C never runs `by_region`. |
| 1.4 Extraction service, budget, identity lookup | Extract the shared extraction service from `extract_dataset_by_sql` (source resolution, authorization, policy, cache, extract, result assembly). The chat tool keeps its LLM caps and slot contract. The SQL node calls the service with workflow inline max rows = 1000, workflow inline max bytes = 1 MB (bytes enforced). Identity index and identity lookup (§7.1), hits also compare `data_source_id`. Replace the `sql.inline_max_*` config keys. | 1.3 | A 350-row result gives the workflow SQL node `returned_rows = total_rows = 350` while chat still caps at 200. A workflow node with the chat's source + SQL hits the chat slot. The same label/SQL on another source misses. |
| 1.5 Save mapping | `build-from-events` v2 | Emit v2 authoring form: derived string ids, v2 `inputs`, replayable flag in the tool registry (SQL, code, chart, `delegate_to_agent`, and the echo-only creators `generate_html_page` / `generate_bento_slides` are replayable; screenshot tools are not, so image artifacts become snapshot-only). Omit non-replayable invocations. **Dead-node pruning via backward reachability traversal from the artifact-creating terminal node (§4.2 rule 6)**, discarding unrelated or abandoned intermediate tool calls. Do not copy chat `row_limit`. Chat `dataset_name` -> `dataset_label`. `dataset_id` -> first chart binding, Strategy Z+ fallback. §4.3 outcome rules. | 1.2 | Tests for each §4.3 row. A chat `row_limit: 5` never reaches the node. A thread with unrelated intermediate tool calls (e.g. user chit-chat or abandoned exploratory queries) produces a minimal spec containing strictly the artifact's ancestor nodes, with zero dangling nodes and zero unused-node warnings. HTML and slide saves still work. |
| 1.6 Save orchestration | Compile + lint on save. Persist the authoring spec. First run with `force_refresh = false` -> snapshot / `snapshot_inputs` / `snapshot_at`. A failure keeps the chat snapshot and writes `last_run_error`. Compute `refreshable` strictly from `not_refreshable` issues in the selected output's ancestor closure, and return any messages. | 1.4, 1.5, 1.7 (columns) | Save right after a chat extraction issues no source query. A truncated-preview chart (≤ 1000 total) yields a complete snapshot. An oversized chart saves with `refreshable = false` and its message without corrupting `inputs.config`. A forced first-run failure is visible in GET. |
| 1.7 Data migration + run semantics | **Irreversible; take a `pg_dump` of the `workflow` and `artifact` tables first.** `pnpm db:generate --name=workflow_v2_artifact_columns`: add `snapshot_inputs`, `last_run_error`, `refreshable`; drop `view_mode`. **CRITICAL FOREIGN KEY SAFETY:** Existing DB schema defines `artifact.workflow_id` with `ON DELETE CASCADE`. A naive `DELETE FROM workflow` would wipe all existing artifacts! The custom migration MUST: 1) Alter the FK on `artifact.workflow_id` to `ON DELETE SET NULL`; 2) Explicitly execute `UPDATE artifact SET workflow_id = NULL, refreshable = false WHERE workflow_id IS NOT NULL` to preserve existing snapshots; 3) Only then execute `DELETE FROM workflow`. `entity_run` history is kept. GET returns snapshot only. Refresh writes/clears `last_run_error` without updating snapshot. User-triggered snapshot endpoint persists verified inputs/data. | 1.1 | Old artifacts open from their snapshot without executing anything. Artifacts with a NULL snapshot and no workflow show an empty state. No GET path calls `executeWorkflow`. Existing artifacts are completely preserved. |
| 1.8 Edit paths + Inspector | `PATCH /api/artifacts/[id]` (spec) and `PATCH .../nodes/[nodeId]` accept authoring-form input, run compile + lint, and return issues (HTTP 400 with the issue list on error; 200 with `not_refreshable` / `warning` issues otherwise). Inspector forms read/write v2 `inputs`, display issues inline at their JSON pointers, and support node rename with ref rewrite. The graph uses string ids. Deletion is blocked while a node is still referenced. `artifactDetail` loses the server-side view-mode toggle (§6). | 1.2, 1.7 | An invalid edit shows every issue next to its field. Changing `data_source_name` to a source outside the allowed set is rejected. |
| 1.9 Events | The recorder persists node summaries (§3.4) instead of full outputs. | 1.3 | Event payload size is bounded regardless of row counts. |
| 1.10 Docs | Replace `workflow.md` with the v2 as-built reference. Update `artifact-filters.md` examples. Update `AGENTS.md` rule references where needed. | 1.1-1.9 | Docs match code. |

### Phase 2 (P1): Data correctness in the shared cache

| Step | Tasks | Done when |
|---|---|---|
| 2.1 | Row schema on hits | The sidecar stores `row_schema`; hits return it. | Hits return the same columns as a fresh extraction. |
| 2.2 | Safe replacement | Forced refresh of an existing identity and chat slot reassignment both use `temp` + `swap` + refcounted deletion (§7.3), replacing `rm -rf` + `rename` in `commitWriteSlot`. | A forced refresh or slot reassignment while Python reads the old directory does not break the reader. |
| 2.3 | Python bridge | `inputs` / `params` / `datasets` via one `_PARAMS_` JSON in workflow code nodes and the chat `run_code_in_sandbox` (fix unforwarded `params`). `HARDCODED_DATASET_PATH` lint (`not_refreshable`). | The same code runs in chat and as a node. A hard-coded path marks the workflow `not_refreshable`. |
| 2.4 | SQL observability | Record compiled SQL and bound values in SQL node events (§3.4). | Visible in admin run detail. |

### Phase 3 (P2): Filters

| Step | Tasks | Done when |
|---|---|---|
| 3.1 | Inputs | Validate the §5.1 subset at compile. Resolve the input bag per run (request > default). Persist `snapshot_inputs`. | Unknown/mistyped/missing inputs rejected server-side before any IO. |
| 3.2 | SQL parameter compiler | §5.3 algorithm (substitute -> parse -> count check -> position check -> bind). Enable per provider only after its tests pass: native binding where available, adapter-owned literal renderer for the DuckDB `COPY` path / Vertica. Policy on executed SQL. Lift `SQL_PARAMS_NOT_ENABLED` per enabled provider. | Per provider: quoted token and commented token rejected by the count check, identifier misuse, null, empty array rewritten to `(1=0)` predicate, non-empty `IN ($1, ...)`, repeated refs, wrong types. |
| 3.3 | Filter UI | RJSF panel wired to `POST /refresh { inputs }` (re-queries live source, updates view without altering snapshot), pre-filled from `snapshot_inputs`. Reset to defaults. Explicit user-triggered "Save as snapshot" button calling `POST /snapshot { inputs }`. Inspector "promote literal to input" (adds a property and rewrites the literal to `@inputs.<key>`). | Example D works end to end from a chat-saved example A. Refresh retrieves fresh source data without altering stored snapshot; Save-as-snapshot persists state explicitly. |

### Phase 4 (P3): Deferred

Multi-chart artifacts, dynamic `options_source` (§5.4), agent editing in the artifact view (§8), native binding for more providers, `condition`/branching, subflows, partitioned refresh, live-vs-snapshot compare.

## 9.1 Touchpoints

| Contract | Primary files |
|---|---|
| Spec v2, compile, lint | `src/lib/workflows/spec/schema.ts`, `canonicalize.ts` -> `compile`, `validate.ts` -> `lint`, `nodes/registry.ts` |
| Save mapping | `src/lib/workflows/build-from-events.ts` |
| Engine refs, selective execution | `src/lib/workflows/engine/execution-context.ts` (drop embedded interpolation), `scheduler.ts` (string ids, ancestor closure), `in-process.ts` |
| SQL node + extraction service + identity index | `src/lib/workflows/nodes/sql-node.ts`, `src/lib/data-sources/runtime-tools.ts`, `cache.ts`, `policy.ts`, provider adapters |
| Chart node | `src/lib/workflows/nodes/chart-node.ts` |
| Python bridge | `src/lib/workflows/nodes/code-node.ts`, `src/lib/artifacts/execute-workflow.ts`, `src/lib/sandbox/runtime-tools.ts` |
| Events | `src/lib/artifacts/workflow-run-recorder.ts` |
| Run semantics, snapshots | `src/lib/artifacts/bundle.ts`, `get-artifact.ts`, `save-snapshot.ts`, `refresh-artifact.ts`, `execute-workflow.ts` |
| Schema + migrations | `src/lib/db/schema.ts` (`ArtifactTable` columns), `src/lib/db/migrations/` (generated column migration + custom `DELETE FROM workflow` migration) |
| Replayable flag | `src/lib/builtin-tools/catalog.ts` and MCP tool metadata |
| Edit paths | `src/app/api/artifacts/[id]/route.ts`, `[id]/nodes/[nodeId]/route.ts`, `src/components/workflow-graph/*` (graph, inspector), `src/components/main-panels/ArtifactDetail.tsx` |
| Filter UI | `src/components/main-panels/ArtifactFilterPanel.tsx`, `src/app/api/artifacts/[id]/refresh/route.ts` |

## 10. Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Multiple charts per artifact | Deferred. A spec may contain several chart outputs; an artifact renders one `workflow_output_field`, and executes only its ancestor closure. |
| D2 | GET behavior & Refresh semantics | GET returns the stored snapshot only; only explicit refresh executes against live source data (`force_fresh: true`, re-queries DB source, does NOT automatically overwrite snapshot). `view_mode` is dropped. Persisting snapshot requires explicit user "Save as snapshot" action. |
| D3 | First-run failure at Save | Save anyway with the chat-captured snapshot and a persisted, visible `last_run_error`. |
| D4 | Workflow inline budget | 1000 rows / 1 MB for now (config keys, §3.1). |
| D5 | Stored form | Persist the authoring form only. Compile on every write and run. No stored lock map or resolved ids. |
| D6 | Oversized chat charts | Saved into `artifact.snapshot` so the chart remains immediately viewable. `chart.inputs.config` strictly remains a pure data-free template (preventing spec bloat and avoiding `CHART_CONFIG_TOO_LARGE`). The chart node receives a `not_refreshable` issue. |
| D7 | SQL parameter syntax | Keep `@inputs.key`. |
| D8 | Agent and generic tool nodes | Keep both: agent executes on refresh / Save's first run only; tool nodes only when `replayable`. |
| D9 | Existing workflows & CASCADE safety | Delete all `workflow` rows (irreversible; `pg_dump` first). The migration MUST alter the FK constraint to `ON DELETE SET NULL` and explicitly run `UPDATE artifact SET workflow_id = NULL, refreshable = false` before deleting `workflow` rows, preventing DB `ON DELETE CASCADE` from wiping existing artifacts. |
| D10 | Node shape | Keep the v1 `inputs` wrapper and field names where semantics are unchanged; string ids, auto-derived at Save. |
| D11 | Resolved-id locks | None. Data-source names are immutable after creation; resolve by name within the allowed set on every compile. Revisit (with a separate `workflow` column, outside the authoring JSON) only if names become mutable. |
| D12 | Cache lookup | Identity-based lookup (`data_source_id` + executed SQL + bound values) lands in Phase 1 so Save hits the chat cache; the chat slot contract is unchanged. |
| D13 | Refreshable scoping | `artifact.refreshable` is evaluated strictly against the ancestor closure of `artifact.workflow_output_field`. Issues in unselected outputs produce spec warnings without disabling refresh for the selected chart. |
| D14 | Save-time dead-node pruning | **[Delivered in Phase 0]** The save pipeline performs a backward reachability traversal from the artifact-creating terminal node to prune orphan/unrelated invocations before persisting, guaranteeing a clean minimal DAG with zero dangling nodes. |

### Appendix: external ideas (borrow the contract, not the platform)

| Project | Borrowed here | Not imported |
|---|---|---|
| Windmill | JSON-Schema flow inputs driving the form; per-argument bindings (static literal vs upstream reference) -> whole-field refs in the spec and explicit dual-mode binding in the Inspector (§8) answering *"where does this data come from without guessing raw ref strings?"*; large data exchanged by dataset reference | Worker fleet, loop DSL, S3/GCS storage, JS expressions in args |
| Zen Engine | Validate the whole graph before execution; terminal output contract verification (§6.3) ensuring the evaluated terminal output actually drives the artifact (complete rows + valid option) answering *"can the calculated output actually power the artifact?"* | Decision tables, a rules engine, forward edges as grammar |
| Flowcraft (TypeScript) | Serializable blueprint + executor registry; LintBlueprint - style issue lists; keep UI layout out of the executable spec; map runtime errors back to nodes and fields for Inspector triage | A second runtime, distributed adapters |
| Node-RED | Approachable graph editing; typed inspection panels | Mutable message bus as a carrier for analytical data |
| dbt | Dependencies derived from references (`ref()` -> `@nodes`); viewable compiled SQL with parameter preview in Inspector; testable data contracts | `var()` -style literal Jinja rendering as a parameter mechanism (that is exactly the injection path §5.3 avoids); incremental/ephemeral models |
| Dagster | Data vs order-only dependencies (`@nodes` refs vs `after`); keep large data out of orchestration memory; row count/schema metadata on outputs; execute ancestor closure of selected output | IO managers, partitions, asset versioning |

> **Key takeaway on workflow trust**: Among external patterns, the two most impactful for Nango's operational credibility are **Windmill's explicit field binding** (§8) and **ZEN Engine's terminal output contract** (§6.3). The former eliminates syntax errors and ref guessing when inspecting data lineage, while the latter guarantees that a "successful run" actually yields complete, renderable data for the user's artifact.
