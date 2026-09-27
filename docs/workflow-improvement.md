# Workflow Dataflow, Parameterization & Filtering Architecture

> **Status**: Architectural Blueprint & Implementation Specification.
> **Audience**: Full-stack engineers, Workflow engine developers, AI Agent architects.
> **Related Documents**: [`workflow.md`](./workflow.md), [`artifact-filters.md`](./artifact-filters.md), [`data-sources.md`](./data-sources.md), [`sandbox.md`](./sandbox.md).

---

## 0. Executive Summary & Design Principles

In data analytics and interactive dashboard scenarios, a workflow is not merely a static replay script—it is a **high-throughput, memory-conscious data computation pipeline** that must respond seamlessly to user filtering, slicing, and drill-down operations.

### 0.1 Architectural Mandate & Guiding Principles

This document serves as the blueprint for a fundamental upgrade of the workflow engine. The design is governed by the following strict mandates established during architectural review:

1. **Re-architecture, Not Patchwork**: The goal is to build a robust, forward-looking foundation capable of supporting complex workflows. We are not patching the existing implementation.
2. **Zero Legacy Baggage**: As the product is pre-launch, this design explicitly ignores backward compatibility with any older workflow schemas or existing legacy data.
3. **AI-Native JSON Orchestration (The Core Focus)**: The engine's fundamental contract is a strictly JSON-based configuration rather than an internal UI state.
   - *Why JSON?* JSON is the native, structured output dialect of LLMs. To allow an Agent to generate, parse, and repair workflows seamlessly as an active co-pilot, the orchestration format must be programmatic.
   - *Why this specific JSON shape?* LLMs generate tokens sequentially (autoregressive). Therefore, we strictly enforce backward-linking (`depends_on: [prev_id]`) instead of forward-linking (like Node-RED's `wires`) to prevent look-ahead hallucinations. We use strict Tagged Unions (`type: "sql"`) to prevent parameter drift.
   - *The Triangle*: The JSON architecture is governed by three pillars: ① Strongly-typed Zod Schemas as the Single Source of Truth, ② Dual-Track Inter-node Data Passing, and ③ Safe SQL Parameterization.
4. **Separation of Authoring Scenarios (Tool vs Node)**: The architecture respects the fundamental divide between two modes of AI interaction. We strictly decouple **Scenario 1 (Ad-hoc Exploration)** where an Agent uses conversational *Tools* imperatively, from **Scenario 2 (Workflow Orchestration)** where a specialized Copilot Agent modifies a declarative *JSON Workflow Node Spec*. Tools and Nodes are unified in execution but strictly layered in their schema contracts (Detailed in §0.3).
5. **Uncompromising Credential Security**: The isolation between Node.js and the Sandbox is a hard security boundary. Database extraction, credential management, and SQL policy enforcement **must** remain in the Node.js main process. Passing raw DB credentials into the user-programmable Sandbox (to bypass Node.js I/O bottlenecks) is strictly forbidden to prevent security leakage.

### 0.2 Core Ground Truths & Decisions

1. **Preserve Concise Numeric Node IDs**: Node IDs remain immutable non-negative integers assigned at birth (`#0`, `#1`, `#2`). They directly correlate with visual graph cards in `<WorkflowGraph />`, keep reference strings short (`@nodes.0.dataset_name`), and eliminate naming ceremonies for compact DAGs (typically 2–8 nodes).

2. **Dual-Track Data Contract (Parquet File-Sharing Anchor)**:
   - Analytical datasets are frequently large (tens of thousands to millions of rows). Returning raw full datasets to the LLM or storing them in the Node.js main process heap is strictly forbidden.
   - Upstream SQL nodes materialize the full result into disk-resident Parquet files (`./tmp/data/<name>/**/*.parquet`). The workflow state and LLM context carry **only a preview (`rows`, up to `row_limit`) and metadata (`row_schema`, `total_rows`)**.
   - Downstream heavy processing mounts the Parquet dataset inside the sandbox without round-tripping through the LLM context.

3. **Sandbox Capabilities**: The Dify Sandbox environment is **persistent (daemonized / warm, zero container startup delay)**, natively equipped with `duckdb>=1.5.5`, `pandas>=3.0.5`, `numpy`, and `pyarrow` (defined in `docker/dify-sandbox/requirements.txt`). No polars.

4. **No In-Process Node.js Transform**: An in-process Node.js transform node is explicitly rejected:
   - Node.js in the main app process lacks native, zero-copy Parquet readers.
   - Performing in-memory transformations in Node.js would require loading entire datasets into the server's JavaScript heap, degrading API throughput and defeating the Parquet architecture.
   - Transformations are instead routed to either **Source SQL Pushdown**, **Sandbox-Native DuckDB/Pandas Pipeline**, or **ECharts Client-Side Transform**.

### 0.3 Node–Tool Relationship: Contract Layering & Elevation Policy

Nango's workflow engine reconciles two authoring contexts that **share execution logic but differ in input contract**. This section codifies the architecture that emerged from the node-vs-tool design review, eliminating wrapper-maintenance cost without sacrificing the workflow engine's reference-resolution and canonicalization semantics.

#### 0.3.1 Two Authoring Contexts

| Context | Actor | Input form | Workflow awareness |
|---|---|---|---|
| **Exploration (chat)** | Chat Agent | `tool_name` + literal `arguments` (`sql_text: "SELECT ..."`) | None |
| **Orchestration (artifact / workflow)** | Copilot Agent | `type: "sql"` + reference-capable `inputs` (`sql_text: "... @inputs.date"`) | Full: node definitions + current spec |

These two contexts never see each other's terminology: the chat layer speaks only in *tools*, the orchestration layer only in *declarative nodes*. A **non-agent translation layer** (`build-from-events.ts` → `assembleNode`) mechanically converts tool calls into nodes at "Save as workflow" time — no LLM participates in extraction.

#### 0.3.2 Execution Unification, Contract Layering

**Execution layer — unified (already true today):** a single generic reference-resolution pass (`execution-context.ts` `resolveRefs` / `resolveRefsInString`) feeds resolved values into each executor, which reuses the underlying tool's core logic (`sql-node.ts` calling `extract_dataset_by_sql`). Tools are never aware of whether a chat Agent or the workflow scheduler invoked them.

**Contract layer — layered (must NOT be unified):** `type:"sql"` / `"code"` / `"agent"` / `"chart"` nodes are not mere wrappers of tool schemas. They are a *semantic enhancement* carrying metadata that a chat tool schema cannot derive:

1. **Canonical-only fields** — `data_source_id` (`x-canonical-only`, resolved from `data_source_name` by canonicalize) exists on node schemas but never on tool schemas. A generic `makeNodeSchema(ToolSchema)` cannot conjure it.
2. **Default-value divergence** — chat `row_limit` defaults to `5` (token economy); workflow `row_limit` defaults to `200` (chart fidelity). A single shared schema object makes these fight.
3. **Two reference morphologies** — `sql_text` carries *embedded* refs (`"... >= '@inputs.date'"`, resolved by `resolveRefsInString`); `datasets` carries *whole-field* refs (`["@nodes.0.dataset_name"]`). A generic "any field may start with `@`" widening cannot distinguish them.

#### 0.3.3 Single Source of Truth (Field Pieces)

Do not copy-paste field definitions between tool and node schemas. Extract reusable Zod field pieces, and let node schemas `.extend()` to add canonical-only fields, strengthen descriptions with reference semantics, and override defaults:

```ts
// Field library (single source of truth)
const sqlTextField        = z.string().min(1).describe("...");
const dataSourceNameField = z.string().min(1).describe("...");

// Tool schema (assembled)
const ExtractDatasetArgs = z.object({
  sql_text: sqlTextField,
  data_source_name: dataSourceNameField,
  row_limit: z.number().int().default(5),   // chat default
});

// Node schema (extends + enhances)
const CanonicalSqlInputsSchema = z.object({
  sql_text: sqlTextField.describe("... @inputs.* / @nodes.* refs resolved before execution."),
  data_source_name: dataSourceNameField,
  data_source_id: z.string().uuid().meta({ "x-canonical-only": true }), // node-only
  row_limit: z.number().int().default(200), // workflow default
});
```

#### 0.3.4 TOOL_TO_NODE_MAPPING Router

Replace scattered `if (toolName === "extract_dataset_by_sql")` branches with a single routing table consulted by `assembleNode`:

```ts
const TOOL_TO_NODE_MAPPING = {
  "extract_dataset_by_sql": { targetNode: "sql",   version: "1" },
  "run_code_in_sandbox":    { targetNode: "code",  version: "1" },
  // ... agent-delegation tool → "agent", chart-generation tools → "chart"
} as const;
```

`assembleNode` looks up this table: a hit converts the tool call into the declared declarative node; a miss falls back to a generic `type:"tool"` node (`source` + `name` + `arguments`, per-instance schema snapshot).

#### 0.3.5 Node Elevation Policy

A tool is elevated to a first-class declarative node **only if** it participates in data-lineage passing (produces a Parquet dataset or `rows` that downstream nodes reference via `@nodes.X.<field>`) **or** receives filter pushdown (`@inputs.*`). Everything else stays a generic `type:"tool"` fallback node.

- **Elevated (declarative):** `extract_dataset_by_sql` (→ `sql`), `run_code_in_sandbox` (→ `code`), chart-generation tools (→ `chart`), agent-delegation tool (→ `agent`).
- **Fallback (`type:"tool"`):** `web_search`, `get_current_datetime`, `repeat_tool`, `run_skill_script`, arbitrary MCP tools — no data lineage, no per-type schema needed.

This policy keeps the declarative node set small (bounded by the data-lineage surface) while guaranteeing lossless extraction of any tool call.

---

## 1. Unified Three-Tier Filtering Pipeline

```
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

---

## 2. Dual-Track Data Passing: Pointers vs. Previews

The SQL node's output contract is already implemented as 5 fixed fields (`sql-node.ts` → `extract_dataset_by_sql` result, registered in `nodes/registry.ts` outputs schema with `additionalProperties: false`). This section documents the semantic split between them.

```
Upstream SQL Node (#0)
 ├── Disk: ./tmp/data/wf_run_n0/**/*.parquet  (Full Dataset: 500,000 rows)
 └── In-Memory Node Outputs (5 fixed fields):
      ├── dataset_name: "wf_run_n0"            ← [Pointer]  Heavy data path → Code nodes
      ├── total_rows: 500000                   ← [Metadata] Row count for display / short-circuit
      ├── returned_rows: 200                   ← [Metadata] Actual inline rows count
      ├── row_schema: { columns: [...] }       ← [Metadata] Schema for LLM code generation
      └── rows: [ { ... }, { ... } ] (top N)   ← [Preview]  Lightweight path → Chart nodes only
```

### 2.1 Volume-Aware Consumption Paths (Small vs. Large Data)

The engine's Dual-Track system adapts dynamically based on the volume of data extracted relative to the node's `row_limit` (typically configured to 100-200 rows):

1. **Small Data Scenario (Total Rows ≤ `row_limit`)**:
   - When a query returns a small dataset (e.g., daily aggregated metrics or a short list of 50 records), the `rows` array contains the **complete, full dataset**.
   - **Lightweight Path**: Downstream Chart nodes, UI renderers, and even LLM evaluators can bind directly to `@nodes.X.rows` to consume the data instantly in-memory. While the Parquet file is still written for consistency, the inline `rows` serves as the complete, lightweight payload.

2. **Large Data Scenario (Total Rows > `row_limit`)**:
   - When extracting massive tables (e.g., 500,000 rows of raw logs), `rows` acts strictly as a **truncated preview**. This hard ceiling prevents Node.js heap exhaustion and LLM context window blowouts.
   - **Heavy Data Path**: Downstream analytical nodes must *not* attempt to use `rows`. Instead, they reference the Parquet pointer via `@nodes.X.dataset_name`.
   - The engine translates this pointer into a read-only sandbox mount (`./tmp/data/<dataset_name>/`). Code inside the Python sandbox queries the full dataset at C++/Rust speed using DuckDB or Pandas directly over the disk-resident Parquet files.



---

## 3. Tier 1: Source Pushdown & SQL Parameter Handling

Filtering at the source database is the most efficient operation because it prevents unnecessary rows from being written to Parquet in the first place.

### 3.1 Two-Phase SQL Parameterization

**Current V1 state** (code evidence in `src/lib/data-sources/`):
- `runtime-tools.ts:66`: tool description says "Bake parameter values into the SQL — bound parameters are not supported in V1."
- DuckDB-extension adapters (postgres/mysql/mariadb) and Vertica adapter throw if `ExtractInput.params` is non-empty.
- `ExtractInput.params` typed as `Record<string, string | number | boolean | null>` — no array type.

The upgrade is delivered in phases:

---

#### Phase 1 — Type-Aware Safe Escaping (Eliminates SQL Injection)

Implemented entirely in `sql-node.ts` before passing the final SQL to `extract_dataset_by_sql`. No adapter changes required.

**Step 1 — Policy check & Identifier Guard (`SPEC_REF_AS_IDENTIFIER`)**:
These are two distinct mechanisms:
1. **Identifier AST Guard**: Parse the *original* template SQL using `node-sql-parser`. Walk the AST. If any `@inputs.<key>` appears in an identifier node (e.g., TableRef, ColumnRef in GROUP BY, or as a format argument to `date_trunc`), reject at save time with `SPEC_REF_AS_IDENTIFIER`. Identifier injection is strictly unsupported.
2. **Read-Only / TableList Policy Guard**: For `validateSqlAgainstPolicy` (which checks table access and read-only constraints), perform a global regex replacement (`/@inputs\.[a-zA-Z0-9_]+/g` → `'__param__'`). This dummy replacement ensures `node-sql-parser` doesn't choke on custom `@inputs` syntax, allowing it to correctly extract table names and verify `SELECT` operations.

**Step 2 — Type-aware value substitution**:
Each `@inputs.<key>` ref is resolved to a concrete value via `ExecutionState`, then escaped according to `input_schema.properties.<key>.type` (including `items.type` for arrays):

| Declared type | Substitution | Example |
|---|---|---|
| `string` | `'value'` with internal `'` → `''` escaping | `'2024-01-01'` |
| `number` | bare numeric literal (validated as finite) | `42` |
| `boolean` | `TRUE` / `FALSE` | `TRUE` |
| `array` | Escapes elements based on `items.type`, formats as `('a', 'b')` or `ARRAY['a', 'b']` | `('user', 'evaluator')` |
| absent / null | `NULL` | `NULL` |

`ExtractInput.params` type extended to accept arrays:
```ts
params?: Record<string, string | number | boolean | null | string[] | number[]>;
```

**Optional filter pattern** — unset parameter → identity branch:
```sql
-- @inputs.status resolves to NULL when not provided
WHERE (@inputs.status IS NULL OR status = @inputs.status)
```

---

#### Phase 2 — Native Prepared-Statement Binding (Vertica Only)

Replace type-aware escaping with true parameterized queries for low-hanging fruit.

| Provider | V1 Path | Phase 2 Path |
|---|---|---|
| **Vertica** | `vertica-nodejs` → NDJSON → Parquet | `client.query({ text, values: [...] })` — driver already supports `$1` binding. |

*(Note: Postgres/MySQL/MariaDB native binding requires replacing DuckDB-extension COPY with a full node native-client-to-NDJSON pipeline. This is a heavy refactor and is deferred to Phase 3/Standalone effort).*

**Spec-layer placeholder convention** — `@inputs.<key>` is the only form ever written in specs. `sql-node.ts` translates at execution time to provider-native positional placeholders (e.g., `$1`).

---

### 3.2 Dynamic Filter Options (`options_source`) & Security Barrier

`input_schema` properties may declare an `options_source` to populate filter dropdowns dynamically:

```jsonc
{
  "type": "object",
  "properties": {
    "initiator": {
      "type": "string",
      "title": "Initiator",
      "widget": "select",
      "options_source": {
        "type": "sql",
        "data_source_name": "nango-db",
        "sql_text": "SELECT DISTINCT initiator AS label, initiator AS value FROM entity_run WHERE initiator IS NOT NULL ORDER BY label ASC"
      }
    }
  }
}
```

// SECURITY: `GET /api/artifacts/[id]/filters` executes `options_source` queries and MUST enforce:
1. Session authentication via `withSession`.
2. Artifact read permission check (`canReadResource`).
3. Data source access verification: reusing `buildUserCatalog` policy.
4. SQL policy enforcement via `validateSqlAgainstPolicy`. No user-controlled parameters are accepted in `options_source` queries.

---

### 3.3 Strongly-Typed `input_schema` (`InputPropertySchema`)

`input_schema` is the shared contract. It must be strongly typed at the Zod level.

```ts
const InputPropertySchema = z.object({
  type: z.enum(["string", "number", "boolean", "array"]),
  items: z.object({ type: z.enum(["string", "number"]) }).optional(), // Required if type="array"
  title: z.string().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  widget: z.enum(["text", "select", "multiselect", "date", "daterange"]).optional(),
  options_source: z.object({
    type: z.literal("sql"),
    data_source_name: z.string(),
    sql_text: z.string(),
  }).optional(),
}).passthrough();
```

`InputPropertySchema.type` is the **single source of truth** for runtime type coercion and bind enforcement. Type mismatch → `WorkflowError(SPEC_SCHEMA_MISMATCH)`.
*(Note: Because this schema is LLM-authored, the system prompt must explicitly document these 4 allowed types and the strict matching requirement to prevent high-frequency hard failures).*

---

## 4. Tier 2: Resident Sandbox In-Place Pipeline (DuckDB / Pandas)

All intermediate and heavy data transformations run inside the **warm, persistent Sandbox**.

### 4.1 Zero-Cold-Start In-Place SQL via DuckDB in Python

```python
import os, json, duckdb

params = json.loads(os.environ.get('NANGO_PARAMS', '{}'))
min_amount = float(params.get('min_amount', 0))
dataset = params.get('dataset', 'wf_run_n0')

con = duckdb.connect()
df_res = con.execute("""
    SELECT date_trunc('day', created_at) AS day, COUNT(*) AS total
    FROM read_parquet('./tmp/data/' || ? || '/**/*.parquet')
    WHERE amount >= ?
    GROUP BY 1
""", [dataset, min_amount]).df()

print(json.dumps({"rows": df_res.to_dict(orient="records")}))
```

---

## 5. Tier 3: ECharts Client-Side Transform

The chart node's ECharts `config` can embed ECharts' native `dataset.transform` for client-side sorting and filtering without server round-trips.

---

## 6. Reference Syntax Specification (Pure & Stable)

1. **No Deep `@nodes` Paths**: `@nodes.<id>.<field>` remains strictly 2 segments.
2. **No `??` Null-Coalescing in `@path`**: Default values belong in `input_schema.properties.<key>.default`.
3. **No Identifier Injection via `@inputs`**: Rejected at save time via AST inspection (`SPEC_REF_AS_IDENTIFIER`).

---

## 7. `depends_on`: Execution Edges vs Data Edges

To eliminate LLM hallucination in DAG construction, Nango strictly separates dependencies into two semantic categories (modeled after dbt's `ref` and Dagster's `deps`):

1. **Data Edges (Auto-Inferred)**: The universal default. Any `@nodes.X.field` reference automatically creates a topological edge.
2. **Execution Edges (Explicit `depends_on`)**: The explicit `depends_on` array is redefined as **"pure dependency, non-data edges"**. It is used *exclusively* for side-effects (e.g., "create a resource, then query it").

### 7.1 Current State

In V1, `depends_on` inference is strictly isolated to **one layer**: `build-from-events.ts` (Strategy Z+). During `rewriteInputViaIndex`, it accumulates referenced `nodeId`s and stamps them onto the node.
`canonicalize.ts` does not infer dependencies. `validate.ts` only consumes the closed graph to verify reachability.

### 7.2 Target Architecture (Phase 3 Deferred)

Eventually, workflows will be modified directly by agents (`modify_workflow`) bypassing `build-from-events.ts`. At that point (Phase 3), `inferDependsOn` will be moved down into `canonicalize.ts` to act as a universal safety net.

**Field Migration Strategy**: Currently (V1), `build-from-events.ts` stamps Data Edges into the `depends_on` array. In Phase 3, we will formalize the split: Data Edges will be dynamically inferred at runtime from `@nodes.X` references and **not persisted**. The persisted `depends_on` field will be strictly reserved for Execution Edges. Strategy Z+ will be updated to only write execution-only side-effect edges into this array.

---

## 8. Parquet Lifecycle & Cache Invalidation Policy

1. **TTL-Based Automatic Eviction**: `.meta.json` with `ttlHours` (default 24h).
2. **Process Boot Purge**: `purgeAllDatasets()` sweeps on startup.
3. **Data Source Deletion Purge**: `purgeDatasetsForDataSource(dataSourceId)`.
4. **Run-Scoped Slots & Content-Addressed Cache (`code_version`)**: Initially, slots use deterministic names (`wf_<runId>_n<nodeId>`). In Phase 3, caching will evolve to be content-addressed via `hash(query_text + resolved_params)`. If a downstream chart filter changes but the upstream extraction node does not, the upstream node hits its materialized Parquet cache instantly rather than re-executing.
5. **Read-Only Sandbox Mounts**: Mounted `:ro`.

---

## 9. Future: `condition` Node (Schema Reserved, Executor Deferred)

For branching (e.g., anomaly detection alerts), a `condition` node type is anticipated. Any spec using an unknown node type fails at save time via `SCHEMA_VERSION_UNKNOWN`. The `NodeTypeSchema` enum may pre-register `"condition"`, but no executor will be implemented until real use cases establish the minimum required shape.

---

## 10. Developer Implementation Guide & Execution Steps

This section translates the architectural blueprints into concrete coding instructions, target files, and step-by-step execution phases for developers.

### Phase 1: Security, Types, and Filter Foundations

**1.1 Strong Typing & Zod Contracts (`input_schema`)**
- **Target File**: `src/lib/workflows/spec/schema.ts`
- **Action**: Replace `z.unknown()` in `LLMWorkflowSpecSchema.input_schema` with the strictly defined `InputPropertySchema`.
- **Implementation Detail**: Ensure `type` is limited to an enum (`"string" | "number" | "boolean" | "array"`). For `array`, require `items: { type: z.enum(["string", "number"]) }`. 
- **Execution Step**: Run `pnpm check-types` after the schema change. Fix any downstream TypeErrors where `input_schema` was assumed to be `any`. Update LLM System Prompts to explicitly list these 4 types to prevent generation drift.

**1.2 Dynamic Filters API (`options_source`)**
- **Target File**: `src/app/api/artifacts/[id]/filters/route.ts` (New Route)
- **Action**: Build the endpoint that hydrates dropdowns for the RJSF form.
- **Implementation Detail**: 
  - Wrap with `withSession` and verify artifact access via `canReadResource(id)`.
  - Extract the `options_source` object from the requested parameter schema.
  - Assert policy safety: `validateSqlAgainstPolicy(sql_text, provider, policy)`. Ensure no user inputs can be injected into this specific SQL.
  - Return `Array<{label: string, value: string | number}>`.
- **Execution Step**: Write RBAC/Policy unit tests in `filters.test.ts`. Wire up the UI frontend to call this endpoint on `<WorkflowFilterPanel />` mount.

**1.3 AST Identifier Guard & Dummy Substitution**
- **Target Files**: `src/lib/workflows/nodes/sql-node.ts`, `src/lib/data-sources/policy.ts`
- **Action**: Split the policy check from the identifier check.
- **Implementation Detail**:
  1. **AST Guard**: Use `node-sql-parser` to parse the *original* SQL template. Walk the AST; if any `@inputs.<key>` string is found within an Identifier node (e.g., `type: 'column_ref'`, `type: 'table'`), throw `WorkflowError(SPEC_REF_AS_IDENTIFIER)`.
  2. **Dummy Replace**: Run `sqlText.replace(/@inputs\.[a-zA-Z0-9_]+/g, "'__param__'")`. Pass this sanitized string to `validateSqlAgainstPolicy` to check read-only constraints and table allowlists.
- **Execution Step**: Add edge-case unit tests (e.g., `@inputs` in `GROUP BY`, in `date_trunc` format string, in `FROM` clause) to ensure they all hard-fail.

**1.4 Type-Aware Safe Escaping**
- **Target File**: `src/lib/workflows/nodes/sql-node.ts` (inside `resolveRefsInString`)
- **Action**: Implement the Phase 1 escaping mechanism.
- **Implementation Detail**: Iterate over regex matches of `@inputs.<key>`. Lookup the type in `ExecutionState.input_schema`.
  - `string`: Wrap in single quotes, replace internal `'` with `''`.
  - `number`: Append as bare literal. Ensure `Number.isFinite()`.
  - `array`: Extract `items.type`. Expand to `('a', 'b')` or `ARRAY['a']` depending on the provider dialect.
  - `null` / Absent: Output `NULL`.
- **Execution Step**: Ensure `ExtractInput.params` type in `types.ts` is updated to include `string[] | number[]`.

**1.5 Field-Level Single Source of Truth & TOOL_TO_NODE_MAPPING**
- **Target Files**: `src/lib/workflows/spec/schema.ts`, `src/lib/data-sources/runtime-tools.ts`, `src/lib/workflows/build-from-events.ts`
- **Action**: Eliminate duplicated field definitions and scattered if-else dispatch (see §0.3).
- **Implementation Detail**:
  1. Extract reusable Zod field pieces (`sqlTextField`, `dataSourceNameField`, `datasetNameField`, `rowLimitField`) and reassemble both `ExtractDatasetArgs` (tool) and `CanonicalSqlInputsSchema` (node) from them. The node schema `.extend()`s `data_source_id` and overrides the `row_limit` default.
  2. Add `TOOL_TO_NODE_MAPPING` and refactor `assembleNode` to consult it instead of hardcoded if-branches.
- **Execution Step**: Run `pnpm check-types` and `pnpm test`; confirm no field-name or type drift remains between the tool and node schemas.

---

### Phase 2: Native Binding & Engine Advancements

**2.1 Native Parameter Binding (Vertica First)**
- **Target File**: `src/lib/data-sources/vertica/extract.server.ts`
- **Action**: Upgrade to proper prepared statements.
- **Implementation Detail**: `sql-node.ts` translates `@inputs.X` to `$1`, `$2` and passes the ordered values via `ExtractInput.params`. The Vertica driver consumes `client.query({ text, values: params })` natively.
- **Execution Step**: Verify the change drops execution latency and fully prevents injection at the driver level. 

**2.2 `x-data-track` Annotations**
- **Target File**: `src/lib/workflows/nodes/registry.ts`
- **Action**: Explicitly declare which outputs are heavy vs lightweight.
- **Implementation Detail**: Add `x-data-track: "heavy"` to `dataset_name`, and `"preview"` to `rows`. Update `validate.ts` to ensure Chart nodes cannot bind to `"heavy"` paths directly.

---

### Phase 3: Copilot Editing, DAG Automation, and Content Cache

**3.1 Content-Addressed Caching**
- **Target Files**: `src/lib/data-sources/runtime-tools.ts`, `src/lib/cache/parquet-manager.ts`
- **Action**: Evolve from Run-Scoped slots to Hash-Scoped slots.
- **Implementation Detail**: Compute `const cacheKey = crypto.createHash('sha256').update(resolved_sql_text).digest('hex')`. The Parquet slot becomes `./tmp/data/ds_<cacheKey>/`. Before extracting, if `getCacheStatus(cacheKey).isFresh`, skip extraction entirely.
- **Execution Step**: Ensure `purgeAllDatasets` is updated to sweep these new `ds_` prefixes.

**3.2 `depends_on` Inference Migration (`inferDependsOn`)**
- **Target Files**: `src/lib/workflows/spec/canonicalize.ts`, `src/lib/workflows/build-from-events.ts`
- **Action**: Move DAG building out of the event builder and into the strict compilation step.
- **Implementation Detail**: 
  - `build-from-events` outputs `depends_on: []` for all data nodes.
  - `canonicalize` runs a global regex `/@nodes\.(\d+)/g` over each node's `inputs`. It pushes discovered IDs into `node.depends_on` (performing a union with any explicitly declared execution edges).
- **Execution Step**: Refactor `validate.ts` cycle detection to run *after* `canonicalize` finishes inference.

**3.3 Copilot Agent Integration (`modify_workflow`)**
- **Target Files**: `src/lib/copilot/resource-registry.ts`, `src/app/api/copilotkit/tools/workflow.ts`
- **Action**: Expose the workflow state to the LLM agent.
- **Implementation Detail**: Use `@copilotkit/react-core`'s `useCopilotDraft` to mount the active JSON spec and current filter values in the React Context. Implement a `modify_workflow` tool that accepts JSON Patches or complete schema overrides from the LLM to add/modify filters and nodes via chat.

## 11. Appendix: Open-Source Architectural Inspirations

> **Purpose**: Documents the architectural evaluation of leading open-source workflow and data engines, explicitly mapping their strengths to the Nango Workflow Engine's underlying design principles.

### 11.1 Windmill (windmill-labs/windmill)

**Overview**: Windmill is a highly scalable, developer-first open-source platform for turning scripts (Python, TypeScript, Go) into workflows and internal UIs.

**What Nango Absorbed:**
1. **Strongly-Typed input_schema (The Zod Contract)**: We adopted Windmill's strict JSON schema philosophy. InputPropertySchema acts as the single source of truth for UI generation, LLM prompting, and runtime type coercion, preventing silent failures.
2. **Dual-Track Data Contract (Parquet Pointers)**: Inspired by Windmill's storage pointers (S3/GCS), Nango rejects passing large data arrays via the engine's memory state. Instead, we pass lightweight pointers (dataset_name) to Parquet files mounted securely in the sandbox.
3. **Uncompromising Credential Security**: Nango strictly keeps all database extraction and credential handling in the Node.js main process, passing only the *results* to the Python/JS Sandbox, heavily mirroring Windmill's secure resource isolation.

### 11.2 Zen Engine (gorules/zen)

**Overview**: Zen Engine is an extremely fast, Rust-based Business Rules Engine (BRE) that executes deterministic JSON Decision Models.

**What Nango Absorbed:**
1. **Pre-flight Type Checking & Validation**: Our decision to enforce SPEC_SCHEMA_MISMATCH and SPEC_REF_AS_IDENTIFIER at the canonicalization/validation layer (before execution) is directly inspired by Zen Engine's deterministic evaluation model.
2. **Stateless canonicalize and validate Pipeline**: The Nango engine treats the workflow spec purely as a data structure. Dependency inference (inferDependsOn) and cycle detection treat the DAG as a mathematical graph, independent of runtime side effects.

### 11.3 Node-RED & FlowCraft (gorango/flowcraft)

**Overview**: Visual dataflow pipelines (Node-RED) and lightweight Go/Rust-based DAG orchestrators (FlowCraft) focused on explicit dataflow passing.

**What Nango Absorbed & Evolved:**
1. **Immutable Numeric Node IDs**: We adopted concise, immutable IDs (#0, #1) to seamlessly sync the visual layer (<WorkflowGraph />) with execution state.
2. **Rejection of the msg.payload Anti-Pattern**: While we absorbed explicit dataflow, we specifically *rejected* Node-RED's tendency to load massive datasets into the in-memory payload (which crushes the Node.js heap). Nango split this into the Dual-Track system.

### 11.4 dbt (Data Build Tool)

**Overview**: The industry standard for data transformation in the warehouse. dbt compiles parameterized SQL, enforces strict materialization strategies, and infers execution order automatically.

**What Nango Absorbed (Synthesized Insights):**
1. **`ref()` & Explicit Fallback → `inferDependsOn`**: In dbt, analysts write `ref('model_a')` and the compiler infers the DAG. Explicit `-- depends_on:` is only used as a fallback for hidden dependencies. Nango adopted this exact dual-model for Phase 3: `inferDependsOn` parsing `@nodes.*` is the universal default, reducing LLM hallucination risks. The explicit `depends_on` array is relegated to a strict fallback.
2. **`var()` Priority Chain → Filter Resolution**: dbt's variable resolution chain (runtime override > project defaults > compilation error) is directly mirrored in Nango's Parameter Resolution Hierarchy (`inputValues` > `schema.default` > `REF_UNRESOLVED`). We explicitly rejected runtime type coercion. While dbt offers coercion helpers (e.g., `as_number`), Nango deliberately diverges here, hard-failing on type mismatch (`SPEC_SCHEMA_MISMATCH`) because LLM-authored schemas require strict failure to prevent logic drift.
3. **Materialization Strategies (`ephemeral` vs `table`)**: We broke the implicit rule that "SQL nodes always write to Parquet". This provides a future blueprint for explicit materialization enumeration. While Nango currently writes all heavy SQL results to Parquet, we plan to evaluate an `ephemeral` strategy (inlined CTEs) in future phases once the complex execution boundary between runtime node orchestration and SQL text compilation is resolved.
4. **Exposures → `spec.outputs` Maturity**: dbt's `exposures` declare downstream consumers (dashboards) as first-class citizens. This inspired the future addition of `maturity` and `type` labels to Nango's chart/artifact output nodes, allowing the engine to perform partial DAG refreshes targeted only at specific visual consumers.

### 11.5 Dagster

**Overview**: A data orchestrator built for machine learning, analytics, and ETL, famous for pioneering Software-Defined Assets (SDAs) and decoupling execution logic from I/O.

**What Nango Absorbed (Synthesized Insights):**
1. **Semantic Split: Data Edges vs `deps` (Execution Edges)**: Dagster strictly separates data flow (handled via function inputs / I/O managers) from pure execution order (declared via `deps=[...]`). Nango absorbed this completely: `@nodes.X` references auto-generate Data Edges, while the `depends_on` array is explicitly redefined as purely "Execution Edges" (no data passed, side-effects only).
2. **Software-Defined Assets & I/O Managers → Dual-Track Dataset**: Dagster shifts focus from "tasks running" to "assets materialized", using pluggable I/O managers to handle storage. Nango's SQL node output (`dataset_name`) is our materialized asset. In Nango's Dual-Track model, the heavy data path (Parquet pointers) maps to Dagster's custom I/O bypass (handling its own large-scale storage), while only the lightweight preview rows utilize the engine's in-memory data passing (true I/O management).
3. **Content-Addressed Caching (`code_version`)**: Dagster invalidates assets based on code changes rather than just time. This informs Nango's caching roadmap: moving from simple TTLs to `hash(query + parameters)` so that unchanged upstream data extractions hit the Parquet cache instantly when only a downstream chart config changes.
4. **Partitions (Future Blueprint)**: Dagster handles large data updates via multi-dimensional partitions (e.g., time + region) rather than full recalculations. While Nango relies on full recalculation via filters in Phase 1/2, Dagster's `MultiPartitionsDefinition` provides the theoretical blueprint for future incremental dataset refreshes.

### 11.6 Synthesis: Nango's Unique Architecture

While absorbing the best practices of these engines, Nango's workflow architecture is uniquely tailored for **AI-Native Data Analytics**:
1. **LLM-First Authoring**: Unlike Windmill or dbt where humans write the code, Nango's JSON structure is designed for an LLM to emit reliably (strict 2-segment references @nodes.X.rows, no complex deep paths).
2. **DuckDB / Parquet Native**: Nango combines Windmill's sandboxing, dbt's parameter pushdown, and Dagster's asset materialization into an integrated DuckDB analytics pipeline, creating an engine optimized specifically for high-throughput dashboarding.
