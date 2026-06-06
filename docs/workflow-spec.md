# Workflow Spec — Node Design Reference

> **Audience**: anyone defining, extending, or generating Nango
> workflow nodes (humans, agents, code that authors `workflow.spec`).
>
> **Status**: This document describes the **post-D39 redesign**. The
> existing implementation under `src/lib/workflows/` still ships the
> pre-D39 shape (camelCase fields, `outputs[]` array in spec, no chart
> node). The phased rollout in `workflow-architecture.md` §4.0 brings
> code in line with this spec. Read this doc when you want to know
> **what the spec WILL look like**; read `workflow.md` for **what the
> code looks like today**.
>
> **Sibling docs**:
> - [`workflow.md`](./workflow.md) — what is currently built
> - [`workflow-architecture.md`](./workflow-architecture.md) — decision
>   log (D1 → D39)
> - This doc (`workflow-spec.md`) — **prescriptive** node-shape
>   contract and the rules that authoring code (especially LLMs) must
>   follow

---

## 1. Positioning: LLM-first node design

Workflow construction in Nango has two authoring paths, with very
different relative volumes:

| Path | Volume | Who emits the JSON |
|---|---|---|
| **LLM-driven** (chat save, `modify_workflow` tool) | **dominant** | the LLM, via `build-from-events` reconstruction or direct tool-call patch |
| **Human-driven UI edits** | minority (rename / disable / tune retry; no canvas editor) | the artifact / workflow PATCH route |

Therefore every node design decision is graded against **how easy
the node is for an LLM to emit correctly**, not against UX for a
human canvas editor. End users do not see node JSON; the LLM does.

The five concrete consequences:

1. **Minimal required fields.** Each required field is one more
   place an LLM can hallucinate. Canonicalize fills defaults.
2. **Self-explanatory keys.** `inputs.name` ("which tool")
   beats `tool_slug`. The LLM doesn't track internal slugs;
   canonicalize resolves them.
3. **Uniform shape across types.** Every node has exactly the same
   top-level skeleton; type-specific things live one level down
   under `inputs`. The LLM learns one structure.
4. **`inputs` ↔ `outputs` symmetry.** Inputs are the **values the
   node consumes** (static, in spec, may contain refs). Outputs are
   the **actual data the node produces** (runtime, persisted in
   `entity_run_event`, never in spec).
5. **Self-documenting `description`.** Always required. It's how
   `modify_workflow` later finds the right node to patch ("change
   the date range step to last 30 days" — the agent locates by
   description, not by id).

---

## 2. Two shapes — LLM-emit vs Canonical

| | LLM-emit | Canonical |
|---|---|---|
| Who writes it | LLM, `build-from-events`, future `modify_workflow` | `canonicalize.ts` only |
| Who reads it | `canonicalize.ts` only | the engine + every consumer (validator, executor, recorder) |
| `inputs` discriminator values (`inputs.name`, `inputs.language`, …) | display values (`"web_search"`, `"python"`) | resolved values; some get pinned via `const` in `input_schema` |
| `input_schema` | absent | **always required** (canonicalize fills it) |
| `output_schema` | absent for tool/sql/agent/chart (canonical-fixed); **optional** for code (to declare structured stdout JSON) | **always required** (canonicalize fills it) |
| `schema_version` per node | absent | stamped to the current per-type version |
| `outputs` array of field names | absent | **does not exist** in canonical either — runtime concept only (see §4.3) |

Pipeline is always **LLM-emit → canonicalize → validate → persist
canonical**. The engine never sees LLM-emit. The modify flow always
reads canonical, hands LLM-emit to the LLM, and re-canonicalizes on
save.

> **Rule**: if a field exists *only* for engine consumption, it
> belongs to canonical-only. Never push canonical-only fields into
> the LLM-emit schema "for symmetry" — every extra required field
> raises hallucination cost.

---

## 3. Schema versioning

Two version stamps live on every canonical workflow. They evolve
independently.

### 3.1 Spec-format version — `spec.version`

Top-level. Tracks the overall workflow JSON layout (presence of
`nodes`, `outputs`, `execution`, etc.). Today: `"1.0"`.

Bump when the **container** shape changes — for example, if
top-level `outputs` ever becomes structured instead of flat refs.

### 3.2 Node-type schema version — `node.schema_version`

Per node. Tracks the schema of a single node *type* (sql / agent /
code / chart / …). Today every node is stamped `schema_version: "1"`.

Bump when a node type adds / removes / changes a **required field**
or changes the meaning of an existing field. Adding **optional**
fields is *not* a bump.

| Action | Bump? |
|---|---|
| Add a new optional field to `sql` node's `inputs` (e.g. `timeout_override`) | ❌ No |
| Add a new required field to `chart` node's `inputs` (e.g. `theme`) | ✅ Yes |
| Rename `inputs.sql_text` → `inputs.query` in `sql` node | ✅ Yes |
| Add a brand-new node type (`chart`) | ❌ No (new types start at `"1"`) |
| Tighten an existing field's validation (string → enum subset) | ✅ Yes if old values rejected |

### 3.3 LLM doesn't emit `schema_version`

Canonicalize stamps the current version onto every node based on its
`type`. Reasons:

- LLM doesn't track version numbers reliably — extra hallucination
  surface for zero benefit
- Server is the only source of truth for "current version of type X"
- Old persisted workflows keep their original `schema_version`, so
  the engine dispatches the right executor automatically

### 3.4 Engine dispatch by version

The executor for each node type is a small `(type, version) → executor`
table:

```ts
const NODE_EXECUTORS = {
  "tool:1":  toolNodeV1,
  "agent:1": agentNodeV1,
  "code:1":  codeNodeV1,
  "sql:1":   sqlNodeV1,
  "chart:1": chartNodeV1,
  // when v2 lands:
  // "sql:2": sqlNodeV2,  // sqlNodeV1 stays for old workflows
};
```

**Rule**: never delete an old executor entry. Old workflows must
keep running. To force migration, write an explicit upgrade pass
(`upgrade.ts:upgradeNode("sql", 1, 2, node)`); never silently
re-dispatch v1 specs through v2 code.

---

## 4. Common node shape

### 4.1 The 8 universal fields

Every node, regardless of type, has the same top-level structure.
The skeleton is **closed** — no type adds, removes, or renames any
of these:

```jsonc
{
  // ── DAG identity + intent (LLM writes; canonicalize unchanged) ──
  "id":           0,                            // numeric, stable within spec
  "type":         "tool|agent|code|sql|chart",
  "description":  "Find recent regulatory updates",
  "depends_on":   [],                            // upstream node ids

  // ── Parameter bag (LLM writes; values may be literals or @path refs) ──
  "inputs":       { /* type-specific contents */ },

  // ── Schemas (canonicalize fills; LLM never writes) ──
  "schema_version": "1",
  "input_schema":   { /* JSON Schema describing `inputs` */ },
  "output_schema":  { /* JSON Schema describing runtime outputs */ },

  // ── Execution policy (optional; LLM may write) ──
  "retries":         { "attempts": 2, "delay_seconds": 1, "backoff": "exponential" },
  "timeout_seconds": 30
}
```

### 4.2 The strict top-level / `inputs` rule

This rule is **closed and load-bearing** — the entire structural
uniformity of node design hinges on it:

> **Top-level fields are ONLY the 8 universal fields above.**
> **Everything else lives under `inputs`** — including type
> discriminator sub-fields (`inputs.name` for tool, `inputs.language`
> for code, `inputs.data_source_id` for sql, `inputs.renderer` for
> chart, etc.).
> **There is no third location.**

Consequences:

- LLM learns **one skeleton** that fits all 5 node types
- Validator's ref-scanning has a single closed domain (`inputs` only)
- `build-from-events` constructs `inputs` with a single function
- `modify_workflow`'s patch surface is naturally bounded
- Adding new node types or new common fields never collides with
  type-specific names

What this rejects (will produce validation errors):
- `tool: "web_search"` at top level → must be `inputs.name`
- `language: "python"` at top level → must be `inputs.language`
- `agent_id` at top level → must be in `inputs.id` (canonicalize-filled)

### 4.3 Static spec vs runtime values

| Concept | Where it lives | Field name |
|---|---|---|
| Parameter values (literals or refs) | spec (static) | **`inputs`** |
| Parameter shape | spec (canonical) | **`input_schema`** |
| Output shape | spec (canonical) | **`output_schema`** |
| **Actual output values** | runtime + `entity_run_event` payload | **`outputs`** (in events, NEVER in spec) |

Refs `@nodes.X.Y` resolve at execute time against the runtime
`outputs` map. The spec has no `outputs[]` field — the field-name
list is fully recoverable from `output_schema.properties`, and
keeping a separate array would just create a consistency hazard.

### 4.4 Snake_case for all spec keys

All spec key names are **snake_case**:

```
✅ depends_on,  input_schema,  output_schema
✅ schema_version,  timeout_seconds,  retries
✅ data_source_id,  total_rows,  row_schema,  agent_id
```

Rationale:
- SQL / Python / DuckDB ecosystems are snake_case; nodes that wrap
  them feel natural
- LLM training data on snake_case is denser (most JSON Schema /
  OpenAPI examples use it for parameter names)
- LLMs occasionally autocomplete camelCase to snake_case or vice
  versa — picking one and enforcing it removes a hallucination axis

### 4.5 Why each universal field exists

| Field | Why |
|---|---|
| `id` | Stable numeric handle for `@nodes.<id>.X` refs and `depends_on`. Numeric (not UUID) keeps JSON readable in LLM emit/diff. |
| `type` | Discriminator; selects the executor + the validation branch. |
| `description` | Required. Lets `modify_workflow` LLM find the right node by intent. Surfaces in `/admin/runs` UI. |
| `depends_on` | Explicit DAG edge. **Not derivable from refs alone** — a node may legitimately depend on another for ordering without consuming its data. |
| `inputs` | Type-specific parameter bag (literals or refs). |
| `schema_version` | §3. |
| `input_schema` | Canonical JSON Schema for `inputs`; canonicalize fills from per-type rule (registry for tool, constants for sql/chart, etc.). |
| `output_schema` | Canonical JSON Schema for what the node produces at runtime. Downstream refs are validated against this. |
| `retries`, `timeout_seconds` | Per-node execution policy. Optional; falls back to `spec.execution`. |

### 4.6 What is **not** in the node shape

- ❌ `outputs[]` (a list of output field names) — see §4.3
- ❌ `position: [x, y]` — Nango has no canvas editor. If a UI
  layout is ever needed, it lives in a separate `workflow_layout`
  table, never in `spec`
- ❌ `name` / `label` — `description` covers display, `id` covers
  identity; two name-ish fields confuse LLMs
- ❌ `enabled: false` / `disabled` — disabling a node breaks DAG
  semantics. To skip work, edit the spec or short-circuit via a
  future `condition` node
- ❌ Inline code for non-`code` nodes — only the `code` node carries
  executable bytes; other types are pure config

---

## 5. Reference syntax — `@path`

All cross-node and cross-scope data references use a single
`@<scope>.<segments...>` grammar:

| Sigil | Resolves to | Example |
|---|---|---|
| `@nodes.<id>.<field>` | An upstream node's runtime output field | `"@nodes.0.dataset_id"` |
| `@inputs.<key>` | A workflow-level input parameter | `"@inputs.region"` |
| `@workflow.outputs.<key>` | A workflow-level output declaration (used in `spec.outputs` only) | n/a inside nodes |

### 5.1 Where refs may appear

- **Only** at any leaf string value inside a node's `inputs` object
  (arbitrarily nested; Strategy Z+ walks arrays recursively)
- Top-level `spec.outputs` map values

Refs are **NOT** allowed in:
- `node.id`, `node.type`, `node.description`, `node.depends_on`
- `node.retries`, `node.timeout_seconds`
- `node.schema_version`, `node.input_schema`, `node.output_schema`
- Any field under `spec` other than `outputs`

The validator's `REF_OUTSIDE_INPUTS` error catches violations.

### 5.2 Why explicit refs (not "outputs auto-flow into next inputs")

A pure "previous outputs = next inputs" model only works for the
trivial linear-chain case. Six concrete cases force explicit refs:

1. **Multiple upstreams** with field-name collisions
2. **Partial consumption** — downstream wants only a subset
3. **Renaming** — bind upstream `name` as `dataset_path` locally
4. **Mixed literals + refs** — `{ "threshold": 100, "ds": "@nodes.0.dataset_id" }`
5. **Cross-level skip** — node 5 directly refs node 0 without
   forcing nodes 1–4 to forward
6. **Workflow-level inputs/outputs** — `@inputs.X` and
   `spec.outputs.X` aren't node-to-node; need the same syntax

CWL, Argo Workflows, GitHub Actions, AWS Step Functions all use
ref-based connection for these reasons. Edge-based systems (n8n,
Dify, Airflow) add a second layer of expression refs anyway —
at production scale, refs are unavoidable.

### 5.3 Future sugar (NOT in v1)

To address the verbose linear-chain case, two sugars are reserved
for a future version:

```jsonc
// Sugar 1 — single-upstream shorthand
{ "depends_on": [0], "inputs": { "dataset": "@upstream.dataset_id" } }
// canonicalize expands to "@nodes.0.dataset_id"; rejected when depends_on.length != 1

// Sugar 2 — full passthrough (probably never; documented to reserve the name)
{ "depends_on": [0], "passthrough": true }
```

**Not implemented today.** Mentioned here so the schema doesn't
preempt them. When added, canonicalize desugars; the canonical form
and the engine remain unchanged.

---

## 6. Node-type reference

Every node type below is documented in the order an LLM needs to
fill in: `type → inputs → schemas → notes`.

### 6.1 `tool` — call a server-side / MCP tool

Aligned with the OpenAI / MCP / Anthropic tool-call standard: a
tool invocation is `{ name, arguments }`. The shape an LLM sees in
chat (when calling a tool live) is **structurally identical** to
the shape it writes into a workflow tool node.

**LLM-emit**:

```jsonc
{
  "id":          0,
  "type":        "tool",
  "description": "Find recent EU AI Act regulatory updates",
  "depends_on":  [],
  "inputs": {
    "name":      "web_search",
    "arguments": { "query": "EU AI Act 2026 enforcement" }
  }
}
```

**Canonical** (canonicalize adds 3 fields):

```jsonc
{
  // ... all LLM-emit fields ...
  "schema_version": "1",
  "input_schema": {
    "type": "object",
    "properties": {
      "name":      { "const": "web_search" },                    // pin chosen tool
      "arguments": { /* registry's parameters schema, embedded */ }
    },
    "required": ["name", "arguments"]
  },
  "output_schema": {
    /* registry's output schema, e.g. for web_search a oneOf of
       success / failure envelopes */
  }
}
```

**Runtime output** (in `entity_run_event` payload):

```jsonc
{
  "outputs": {
    "ok":       true,
    "provider": "exa",
    "results":  [ { "title": "...", "url": "...", "snippet": "..." } ]
  }
}
```

#### Design points

| Point | Detail |
|---|---|
| `inputs.name` | The tool's registered name, **pinned with `const`** in canonical `input_schema`. Once a tool node is saved, the chosen tool is frozen — changing it = a different node. |
| `inputs.arguments` | The value bag passed to the tool. Shape is governed by the tool registry's `parameters` schema, embedded into the node's `input_schema.properties.arguments` at canonicalize time. Values may contain `@path` refs (resolved at execute time). |
| **`arguments` vs `parameters`** | Two **different concepts** by industry convention. `parameters` = schema (owned by the tool registrant). `arguments` = values (provided by the caller). No translation; they coexist at separate layers. |
| `arguments` may be `{}` | Empty arguments are allowed but the key must exist — keeps the shape uniform. |
| `output_schema` | Pulled from the tool registry. Tools that ship a `ok: true / false` envelope (e.g. `web_search`) get a `oneOf` discriminator that downstream consumers can branch on. |

#### Rejected as `tool` nodes (promoted to their own types)

| Tool name | Becomes | Why |
|---|---|---|
| `generate_echarts_config` | `chart` node (D39) | Becomes refreshable; data binding via `@path` ref. (Pre-D39 name: `render_chart`, formerly a frontend tool.) |
| `run_code_in_sandbox` | `code` node (D35) | Explicit language + custom output schemas |
| `extract_dataset_by_sql` | `sql` node (D36) | First-class dataset identity + DuckDB binding |

Validate rejects these with `PROMOTED_TOOL_AS_NODE` and a hint
pointing at the right node type.

### 6.2 `sql` — DuckDB-dialect SQL extraction

Single-engine: DuckDB. The dialect is implicit (not in `inputs`).
The node always materializes a parquet snapshot so downstream code
nodes can mount it; whether `rows` is delivered in full or only as
a preview is decided by **engine policy** (configurable thresholds,
see §6.2.4), not by LLM choice.

**LLM-emit**:

```jsonc
{
  "id":          0,
  "type":        "sql",
  "description": "Pull monthly sales totals for 2026",
  "depends_on":  [],
  "inputs": {
    "data_source_id": "prod_pg",
    "sql_text":       "SELECT month, sum(total) AS sales FROM orders WHERE year = 2026 GROUP BY 1",
    "dataset_id":     "monthly_sales_2026"
  }
}
```

`dataset_id` is optional; engine derives `sql_<node_id>_<sql_text_hash_8>`
when omitted. Re-running with the same `dataset_id` overwrites the
slot (last-write-wins, D37).

Naming note: `inputs.sql_text` is parallel to code node's
`inputs.code_text` — both name "source code text in some DSL".

**Canonical**:

```jsonc
{
  // ... all LLM-emit fields ...
  "schema_version": "1",
  "input_schema": {
    "type": "object",
    "properties": {
      "data_source_id": { "type": "string",
        "description": "Registered data_source identifier" },
      "sql_text": { "type": "string",
        "description": "DuckDB-dialect SQL; routed through data-sources/policy.ts (no writes, table allowlist)" },
      "dataset_id": { "type": "string",
        "description": "Optional slot id; engine derives if omitted. Re-running with the same value overwrites the slot." }
    },
    "required": ["data_source_id", "sql_text"]
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "dataset_id":    { "type": "string",
        "description": "Stable id; code nodes load the materialized parquet by mounting ./data/<dataset_id>/data.parquet" },
      "total_rows":    { "type": "number",
        "description": "Total rows the query produced (server-side count)" },
      "returned_rows": { "type": "number",
        "description": "Count of rows present in `rows` — equals total_rows when fully inline; less (typically 5) when only preview is delivered. Given as a number so LLM doesn't need to count." },
      "rows":          { "type": "array",
        "items": { "type": "object", "additionalProperties": true },
        "description": "Row data. Length == returned_rows." },
      "row_schema":    { "type": "object",
        "description": "JSON Schema describing each item in `rows`; filled at execute time from DuckDB result column types. Downstream chart/code nodes read this to write column-name-bound encodings." }
    },
    "required": ["dataset_id", "total_rows", "returned_rows", "rows", "row_schema"]
  }
}
```

#### 6.2.1 Runtime output examples

**Inline** (small data, all rows delivered):

```jsonc
{
  "dataset_id":    "monthly_sales_2026",
  "total_rows":    24,
  "returned_rows": 24,
  "rows": [
    { "month": "2026-01", "sales": 12500 },
    /* ... 24 rows total ... */
  ],
  "row_schema": {
    "type": "object",
    "properties": {
      "month": { "type": "string" },
      "sales": { "type": "number" }
    },
    "required": ["month", "sales"]
  }
}
```

**Cached** (large data, preview only):

```jsonc
{
  "dataset_id":    "huge_logs_2026",
  "total_rows":    2347192,
  "returned_rows": 5,
  "rows": [
    { "ts": "2026-01-01T00:00:00Z", "level": "INFO",  "msg": "..." },
    /* ... 5 rows preview ... */
  ],
  "row_schema": {
    "type": "object",
    "properties": {
      "ts":    { "type": "string" },
      "level": { "type": "string" },
      "msg":   { "type": "string" }
    },
    "required": ["ts", "level", "msg"]
  }
}
```

#### 6.2.2 Why `returned_rows` (not derivable from `rows.length`)

LLMs do not count reliably. Asked "how many rows are in this array",
a model **guesses** based on pattern-matching, not by iterating — it
frequently miscounts arrays of 20+ items, biasing toward round
numbers. The pair `(total_rows, returned_rows)` lets the LLM **read
two integers** instead of counting, which is reliable. Truncation
becomes a numeric comparison (`returned_rows < total_rows`), which
LLMs handle well.

`is_truncated` is **not** included — it's fully derivable from the
two counts, and a redundant boolean introduces a consistency-bug
surface (what if it drifts from the numbers?).

#### 6.2.3 Empty results

`total_rows: 0`, `returned_rows: 0`, `rows: []`. **`row_schema` is
still populated** — DuckDB returns column metadata even for empty
result sets. Charts and downstream code can still know what the
columns *would* have been (axis rendering, code expectations).

#### 6.2.4 Engine policy: inline vs cached

The engine decides per execution:

| Mode | Condition | Behaviour |
|---|---|---|
| **Inline** | `total_rows ≤ sql.inline_max_rows` AND serialized JSON ≤ `sql.inline_max_bytes_mb` | `rows = all rows`, `returned_rows = total_rows`, parquet still materialized at `dataset_id` |
| **Cached** | Either threshold exceeded | `rows = top 5 rows`, `returned_rows = 5`, parquet at `dataset_id` is the source of truth |

Two config keys govern the thresholds; both ship with defaults and
can be tuned by operators without code changes:

| Config key | Default | Unit |
|---|---|---|
| `sql.inline_max_rows` | `100000` | rows |
| `sql.inline_max_bytes_mb` | `20` | MB (serialized JSON) |

LLMs do not see these thresholds and **do not** choose the mode —
this was a deliberate decision: forcing the LLM to pick `inline`
vs `cached` would only introduce errors, because the LLM can't
know the data size ahead of execution.

### 6.3 `code` — sandboxed code execution

Run a user-authored snippet in an isolated sandbox. Two source
modalities: inline string (`code_text`) or a file mounted in the
sandbox (`code_file`). Two language interpreters in v1:
`"python"` and `"javascript"`.

**LLM-emit**:

```jsonc
{
  "id":          1,
  "type":        "code",
  "description": "Aggregate monthly sales by region",
  "depends_on":  [0],
  "inputs": {
    "language":  "python",
    "code_text": "import pandas as pd\ndf = pd.read_parquet(f'./data/{datasets[0]}/data.parquet')\nresult = df.groupby('region')['sales'].sum()\nprint(result.to_dict())",
    "datasets":  ["@nodes.0.dataset_id"],
    "params":    { "min_count": 10 }
  }
}
```

Or, with a pre-mounted file instead of inline text:

```jsonc
{
  "inputs": {
    "language":  "python",
    "code_file": "main.py",
    "datasets":  ["@nodes.0.dataset_id"]
  }
}
```

LLM-emit may add a top-level `output_schema` field to structure
the output beyond stdio (see §6.3.3).

**Canonical**:

```jsonc
{
  // ... all LLM-emit fields ...
  "schema_version": "1",
  "input_schema": {
    "type": "object",
    "properties": {
      "language":  { "const": "python" },                 // pinned to chosen value
      "code_text": { "type": "string",
        "description": "Source code as string; piped to interpreter stdin. Mutually exclusive with code_file." },
      "code_file": { "type": "string",
        "description": "Filename relative to ./code/ in the sandbox. The file must exist at execute time. Mutually exclusive with code_text." },
      "datasets":  { "type": "array",  "items": { "type": "string" },
        "description": "Dataset IDs; each appears at ./data/<id>/data.parquet read-only" },
      "params":    { "type": "object", "additionalProperties": true,
        "description": "Free-form parameter object injected into the code as the `params` variable" }
    },
    "required": ["language"]
    // Either code_text or code_file is required (XOR enforced by validator)
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "stdout":      { "type": "string" },
      "stderr":      { "type": "string" },
      "exit_code":   { "type": "number" },
      "duration_ms": { "type": "number" }
      // When LLM emits a custom output_schema, its top-level
      // properties merge in here as non-required additions.
    },
    "required": ["stdout", "stderr", "exit_code", "duration_ms"]
  }
}
```

#### 6.3.1 Code source: `code_text` XOR `code_file`

Exactly one must be specified. Both / neither → validation error
(`CODE_BOTH_TEXT_AND_FILE` / `CODE_NEITHER_TEXT_NOR_FILE`).

- **`code_text`**: source code as a string; engine pipes to
  interpreter stdin (Python `python3 -`, JavaScript via `node` reading stdin).
- **`code_file`**: filename relative to `./code/` in the sandbox cwd.
  The file is assumed to exist (uploaded via a future tool, or
  pre-mounted in the sandbox volume). `code_file: "subdir/main.py"`
  resolves to `./code/subdir/main.py`.

If `code_file` is set, multi-file packages work naturally — the
file may import / require sibling files in `./code/`.

#### 6.3.2 Engine-injected variables

Before executing user code, the engine prepends 0–2 variables based
on what's present in `inputs`:

**Python** (if `inputs.datasets` non-empty AND/OR `inputs.params` non-empty):
```python
datasets = ['sql_node_0_a8c4', 'sql_node_1_e29f']
params = {'min_count': 10}

# ─── user code starts here ───
```

**JavaScript** (only `params` — `datasets` not supported for JS, see §6.3.4):
```javascript
const params = {min_count: 10};

// ─── user code starts here ───
```

Variable name conventions are fixed (`datasets`, `params`). If
user code re-assigns them, that's the user's responsibility.

#### 6.3.3 Custom `output_schema`

If the LLM emits a top-level `output_schema`, the code is expected
to print valid JSON to stdout matching that schema. Engine parses
stdout as JSON and exposes the top-level keys as
`@nodes.<id>.<key>`.

Canonical merges the LLM's `output_schema.properties` into the
default schema **as non-required additions** — the four stdio
fields stay `required` so debugging always works even when code
crashes before printing JSON:

```jsonc
"output_schema": {
  "type": "object",
  "properties": {
    "stdout":      { "type": "string" },
    "stderr":      { "type": "string" },
    "exit_code":   { "type": "number" },
    "duration_ms": { "type": "number" },
    "quarters":    { "type": "array"  },  // ← LLM's custom field (non-required)
    "growth":      { "type": "number" }   // ← LLM's custom field (non-required)
  },
  "required": ["stdout", "stderr", "exit_code", "duration_ms"]
}
```

Downstream `@nodes.X.quarters` resolves at runtime if the code
printed valid JSON; otherwise it's `undefined` and the consumer
should check `@nodes.X.exit_code`.

#### 6.3.4 JavaScript limitations in v1

v1 JavaScript runtime has no pre-installed parquet library. As a
result:

- **`inputs.datasets`** is **not allowed** for `language:
  "javascript"`. Validator rejects with `JS_DATASETS_NOT_SUPPORTED`,
  pointing the LLM either to Python or to passing pre-aggregated
  rows via `inputs.params`.
- **`inputs.params`** works for any size of small JSON-serializable
  data — typical pattern: upstream SQL/code emits inline rows →
  ref'd into JS node's `params` for in-memory transformation.

#### 6.3.5 Filesystem contract

| Path | Contents | Permissions |
|---|---|---|
| `./data/<dataset_id>/data.parquet` | SQL/upstream-code materialized parquet | Read-only |
| `./code/<filename>` | Pre-mounted code files (when `code_file` is used) | Read-only |
| `./` (cwd) | User-writable scratch | Read-write |
| (anywhere else) | No access | — |

### 6.4 `agent` — delegated agent run

Run a built-in agent with a single string task (+ optional context
string). In v1, the input/output contract is intentionally tiny
(`{task}` in, `{result}` out); structured args/results are a v2
plan.

**LLM-emit**:

```jsonc
{
  "id":          2,
  "type":        "agent",
  "description": "Summarise the quarterly rollup in 200 words",
  "depends_on":  [1],
  "inputs": {
    "name":    "data_analyst",
    "task":    "Summarise this dataset in 200 words",
    "context": "Q2 2026 sales by region; values in CNY"
  }
}
```

**Canonical** (canonicalize adds 4 fields):

```jsonc
{
  // ... all LLM-emit fields ...
  "schema_version": "1",
  "inputs": {
    "name":    "data_analyst",
    "id":      "550e8400-e29b-41d4-a716-446655440000",   // ← canonicalize fills (UUID resolved)
    "task":    "Summarise this dataset in 200 words",
    "context": "Q2 2026 sales by region; values in CNY"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "name": { "const": "data_analyst" },                       // pin display name
      "id":   { "const": "550e8400-e29b-41d4-a716-446655440000" }, // pin UUID
      "task": {
        "type": "string",
        "description": "Primary instruction to the agent. May be a literal or a @path ref to an upstream string field."
      },
      "context": {
        "type": "string",
        "description": "Optional background information delivered alongside the task. May contain a @path ref."
      }
    },
    "required": ["name", "id", "task"],
    "additionalProperties": true   // ← allow future fields; only `task` is contractually required today
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "result": {
        "type": "string",
        "description": "Agent's final assistant message, as plain text"
      }
    },
    "required": ["result"]
  }
}
```

#### 6.4.1 Agent eligibility

`inputs.name` may reference any agent **with `role IS NULL`** in
the catalog. System-role agents (`supervisor`, `secretary`,
`evaluator`) are non-routable. Canonicalize rejects with
`AGENT_ROLE_NOT_ROUTABLE`.

#### 6.4.2 `task` and `context` ref forms

Two valid forms:

| Form | Example | Notes |
|---|---|---|
| Literal string | `"task": "Summarise the data"` | LLM writes free text |
| Full-field ref | `"task": "@nodes.1.result"` | Entire field is a `@path` ref; resolves to the upstream string value |

**Not supported in v1**: string interpolation (e.g.,
`"task": "Summarise: @nodes.1.result"`). The engine treats values
as atomic — either a literal or a whole-field ref.

If a ref resolves to a non-string at runtime, the engine throws
`REF_TYPE_MISMATCH`. The LLM should ref string fields only.

#### 6.4.3 Why the v1 contract is so narrow

**Supersedes D30.** The pre-D39 default agent output schema was
`{ text: string }` and LLM-emit was required to provide it. v1
makes the schema a per-type **constant** (`{ result: string }`),
removing one more thing the LLM has to author. Future v2 may relax
this when structured agent outputs become a real product need.

#### 6.4.4 Engine behaviour

When the chart node executes, the engine constructs a single user
message (`task`, optionally prepended with `context`), dispatches
via `runner.start({ mode: "sync", entityId: inputs.id, ... })`,
waits for the sub-run, and returns the final assistant text as
`{ result }`. The sub-run gets its own `entity_run` row with
`parent_run_id` set to the workflow run.

### 6.5 `chart` — declarative chart output (D39)

A first-class node that produces a complete ECharts option JSON
ready for `<EChartsRenderer />`. The node **stores the
chart-config template** (no data); the engine merges live data
from upstream at execute time. The chart node is intentionally
**not** an agent — see §6.5.5 for why.

**LLM-emit** (the saved-state form — see §6.5.4 for how it
relates to chat-time `generate_echarts_config`):

```jsonc
{
  "id":          3,
  "type":        "chart",
  "description": "Bar chart of monthly sales",
  "depends_on":  [0],
  "inputs": {
    "renderer": "echarts",
    "config": {
      "dataset": { "dimensions": ["month", "sales"] },
      "xAxis":   { "type": "category" },
      "yAxis":   { "type": "value" },
      "series":  [{ "type": "bar", "encode": { "x": "month", "y": "sales" } }]
      // dataset.source is intentionally absent; engine fills it
    },
    "dataset": "@nodes.0.rows"   // OPTIONAL; string OR string[] (multi-dataset).
                                  // Absent for the D39.C not-refreshable
                                  // fallback — see §6.5.3.
  }
}
```

**Canonical** (canonicalize adds 3 fields):

```jsonc
{
  // ... all LLM-emit fields ...
  "schema_version": "1",
  "input_schema": {
    "type": "object",
    "properties": {
      "renderer": { "const": "echarts" },
      "config":   { "type": "object", "additionalProperties": true,
        "description": "ECharts option template; engine fills config.dataset.source at execute time when `dataset` is bound" },
      "dataset":  {
        "oneOf": [
          { "type": "string",
            "description": "Single dataset ref to upstream array" },
          { "type": "array", "items": { "type": "string" }, "minItems": 2,
            "description": "Multi-dataset refs (≥2)" }
        ]
      }
    },
    "required": ["renderer", "config"]
    // `dataset` is intentionally NOT required — its absence
    // signals the D39.C fallback (data is baked into `config`).
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "option": {
        "type": "object",
        "description": "Merged ECharts option ready for <EChartsRenderer />"
      }
    },
    "required": ["option"]
  }
}
```

#### 6.5.1 Engine merge logic

```ts
async function executeChartNode(node, state) {
  const ref = node.inputs.dataset;
  const config = structuredClone(node.inputs.config);

  if (Array.isArray(ref)) {
    // Multi-dataset
    const resolved = ref.map(r => resolveRefs(r, state));
    config.dataset = resolved.map((src, i) => ({
      ...(Array.isArray(config.dataset) ? config.dataset[i] : {}),
      source: src,
    }));
  } else {
    // Single dataset
    const resolved = resolveRefs(ref, state);
    config.dataset = { ...(config.dataset ?? {}), source: resolved };
  }

  return { option: config };
}
```

The engine deep-clones `config`, sets `dataset.source` from the
resolved ref, and returns the merged option. ECharts accepts all
three data formats (2D array, array of objects, object of arrays)
natively — the engine doesn't transform shapes.

#### 6.5.2 D39.B single injection point

v1 supports **only `option.dataset.source`** as the data binding
target. `series[*].data` literals are NOT auto-bound to refs.

This keeps the LLM contract narrow:
- All data flows through one well-known JSON path
- Validator only needs to check one location
- `build-from-events` Strategy Z+ only scans one location for
  matches when reconstructing refs

#### 6.5.3 D39.C literal fallback

When `build-from-events` cannot match the inline data in a chat's
`generate_echarts_config` call against any upstream tool's output
(e.g., LLM hardcoded sample values), the chart is still saved — but
with literal `config.dataset.source` baked in and **no
`inputs.dataset` ref**. UI surfaces a "not refreshable" indicator.

#### 6.5.4 Two LLM authoring contexts

This is the most easily-confused part of the chart design — write
it down clearly:

| Context | LLM-facing tool | Data present in LLM output? | Why |
|---|---|---|---|
| **chat-time** | `generate_echarts_config` (**server** tool; pre-D39 it was a frontend tool called `render_chart`) | ✅ Yes — full data inline | Frontend immediately renders the chart for the user; data must be in the option. The server-tool `execute()` is a pure validator (size cap + structure check) and returns the option; a frontend side-effect hook listens on the AG-UI `tool_call_result` event to update the Outcomes store. The frontend `useRenderTool` continues to provide streaming-arg preview. |
| **save-time** | (no LLM — `build-from-events` transforms automatically) | n/a | Strips inline data; replaces with ref. Tool-name suffix (`_echarts_config`, `_plotly_config`, …) determines the chart node's `inputs.renderer` value. |
| **modify-time** (v2 `modify_workflow`) | `modify_workflow` (server tool) | ❌ No — template only | LLM reads existing chart node spec (already a template) and patches `config`; data isn't needed because upstream `row_schema` provides column names |
| **execute-time** (refresh) | (no LLM — engine merges) | n/a | Engine fills `dataset.source` from fresh upstream data |

`generate_echarts_config` tool description teaches the LLM to use
the `dataset.source` format (not `series[*].data`) and to use
upstream column names in `series[*].encode`. This makes
refresh-time data merge work seamlessly.

Future expansion: when Plotly / Vega / etc. are added, they get
their own server tools (`generate_plotly_config`,
`generate_vega_config`, …) with library-specific parameter
shapes. Each library tool name maps 1:1 to the chart node's
`inputs.renderer` field via the `_<lib>_config` suffix
convention.

#### 6.5.5 Why chart is NOT a dynamic agent

A reasonable architectural alternative would be: chart node holds
a prompt; at execute time, an agent is called with the upstream
`row_schema` + a 5-row preview, and returns the ECharts config.
**v1 rejects this** for these reasons:

- **Cost**: every refresh becomes an LLM call; scheduled refresh
  becomes expensive
- **Determinism**: users expect a saved chart to look the same
  across refreshes; agent variability would surprise them
- **Industry precedent**: every mature BI tool (Tableau, Looker,
  Metabase, Superset) ships static-config + dynamic-data charts
- **The "LLM lacks data" worry is moot**: at chat-time
  (`generate_echarts_config`) the LLM already has the SQL preview
  in its context window; at modify-time it has `row_schema` from
  upstream — neither needs a runtime LLM call

If a user actually wants dynamic chart-type selection, v2 can add
that as a **separate pattern** (e.g., an `agent` node producing
the config + a chart node consuming it via ref). The chart node
itself stays a pure static-template + data-merger.

### 6.6 Reserved for future versions

| Type | Use | Status |
|---|---|---|
| `condition` | If / branch routing | Not designed |
| `loop` / `iterate` | Per-item iteration over an array output | Not designed |
| `team` | Run a `builtin_team` instead of a single agent | Not designed |
| `http` | Plain HTTP call without going through the tool registry | Not designed — currently use `tool` node with the HTTP MCP server |

Listed only so future PRs reserve the names — none is part of the
v1 spec.

---

## 7. Workflow-level shape

```jsonc
{
  "version": "1.0",                       // spec-format version (§3.1)
  "name":        "Quarterly Sales Report",
  "description": "Pulls 2026 monthly totals, rolls up to quarters, charts it",

  "input_schema": {                       // optional, JSON Schema subset
    "type": "object",
    "properties": { "region": { "type": "string" } }
  },

  "nodes": [ /* §6 */ ],

  "outputs": {                            // flat ref map (workflow-level outputs)
    "chart":      "@nodes.3.option",
    "row_count":  "@nodes.0.total_rows"
  },

  "execution": {                          // optional, per-workflow policy
    "max_parallelism": 4,
    "timeout_seconds": 120,
    "on_failure":      "stop"
  },

  // Canonical-only:
  "refReconAlgorithm": "ref_recon_v1"
}
```

`artifact.workflowOutputField` picks **one** key from `outputs` as
the artifact's primary data. Other keys are forensic / multi-view
candidates.

Top-level `spec.outputs` map declares **workflow-level** outputs
referenceable from outside; per-node output values live in
`entity_run_event` payloads at runtime (§4.3).

---

## 8. Validation and error contract

`validate(canonical)` runs after `canonicalize` and produces
LLM-readable errors. The contract:

| Error code | Meaning | Example message |
|---|---|---|
| `REF_TARGET_MISSING` | `@nodes.X.Y` points to a non-existent node id | `"@nodes.5.dataset_id" references node 5, which does not exist. Known ids: 0, 1, 2.` |
| `REF_FIELD_MISSING` | Node exists, but the field isn't in its `output_schema.properties` | `"@nodes.0.foo" references field "foo"; node 0 (sql) produces ["dataset_id", "total_rows", "returned_rows", "rows", "row_schema"].` |
| `REF_OUTSIDE_INPUTS` | A `@path` ref appears in a forbidden location (e.g. `node.description`, `node.retries`) | `Ref "@nodes.0.x" found in node.description — refs are only allowed inside node.inputs and spec.outputs.` |
| `CYCLE_DETECTED` | `depends_on` graph has a cycle | `Cycle: 0 → 1 → 2 → 0.` |
| `OUTPUT_REF_UNRESOLVED` | `spec.outputs.X` ref doesn't resolve | `spec.outputs.chart references @nodes.99.option; node 99 does not exist.` |
| `UNKNOWN_AGENT` | `inputs.name` for agent not in catalog | `Agent "data_sciantist" not found. Did you mean: "data_analyst", "data_scientist"?` |
| `UNKNOWN_TOOL` | `inputs.name` for tool not registered | `Tool "web_serch" not registered. Did you mean: "web_search"?` |
| `PROMOTED_TOOL_AS_NODE` | LLM tried to put a promoted tool (`generate_echarts_config`, `run_code_in_sandbox`, `extract_dataset_by_sql`) as `type: "tool"` | `"generate_echarts_config" is a server tool that becomes a chart node when saved; use type: "chart" instead.` |
| `SCHEMA_VERSION_UNKNOWN` | Persisted node has a version with no executor | `Node 2: type "sql" version "3" not supported by this build (max: "2").` |
| `SQL_INLINE_OVERFLOW` | (runtime, not save-time) sql node produced too many rows / bytes for current thresholds | `Node 0 (sql) produced 250000 rows / 30 MB exceeding inline_max thresholds; result delivered as cached preview.` |
| `TOP_LEVEL_KEY_NOT_ALLOWED` | LLM-emit put a non-universal field at top level | `Node 1: unknown top-level field "language" — type-specific params live under inputs.` |
| `CASE_NOT_SNAKE_CASE` | Spec key uses camelCase | `Node 0: key "dataSourceId" is camelCase; spec requires snake_case ("data_source_id").` |
| `CODE_NEITHER_TEXT_NOR_FILE` | `code` node has neither `inputs.code_text` nor `inputs.code_file` | `Node 1 (code): neither inputs.code_text nor inputs.code_file is set; exactly one is required.` |
| `CODE_BOTH_TEXT_AND_FILE` | `code` node has both `inputs.code_text` and `inputs.code_file` | `Node 1 (code): both inputs.code_text and inputs.code_file are set; they are mutually exclusive.` |
| `JS_DATASETS_NOT_SUPPORTED` | `code` node with `language: "javascript"` and non-empty `inputs.datasets` | `Node 1: language="javascript" cannot consume datasets. v1 JS runtime has no parquet reader. Use language="python" or pass small data via inputs.params.` |
| `AGENT_ROLE_NOT_ROUTABLE` | `agent` node refs an agent with non-null role | `Agent "Nango" has role='supervisor' and cannot be used in agent nodes. Only user-authored agents (role=null) are routable.` |
| `REF_TYPE_MISMATCH` | Resolved `@path` ref produces a value of wrong type for the consuming field | `Node 2 (agent): inputs.task resolved @nodes.1.rows to an array, but agent.inputs.task requires string.` |

**Rule**: every error includes the offending value AND the list of
valid alternatives. This is the single most useful affordance for
an LLM trying to self-correct on retry — the typo-with-suggestion
pattern is worth the implementation cost.

---

## 9. Authoring rules for LLM contracts

These rules govern any tool / prompt that asks an LLM to author or
modify a node.

### 9.1 What the LLM SHOULD emit

- Only LLM-emit shape (never canonical-only fields)
- Exactly the 8 universal top-level keys (plus optional `retries` /
  `timeout_seconds`)
- All type-specific parameters **inside `inputs`**
- All keys in **snake_case**
- Numeric `id`, sequential from 0
- Required `description` ≥ 1 sentence — used for later modification
- `depends_on` even if the node has no upstreams (`[]`)
- For `tool`: `inputs = { name, arguments }` matching OpenAI / MCP
  standard
- For `agent`: `inputs = { name, task, context? }` — flat
  fields, no nested `args`. Output is canonical-fixed
  `{ result: string }`; LLM does NOT emit `output_schema`.
- For `code`: `inputs.language` enum (`python` / `javascript`) +
  exactly one of `inputs.code_text` / `inputs.code_file`; optional
  `inputs.datasets` and `inputs.params`. LLM MAY emit a custom
  `output_schema` to expose structured stdout JSON fields.
- For `sql`: `inputs.data_source_id` + `inputs.sql_text`
  (+ optional `inputs.dataset_id`). LLM does NOT pick a return
  mode; engine policy.
- For `chart`: `inputs.renderer` + `inputs.config` template +
  `inputs.dataset` ref(s). `config.dataset.source` is NOT written
  by the LLM — engine fills.
- `@path` refs as plain strings, **only inside `inputs`** values
  (or `spec.outputs` map values)

### 9.2 What the LLM MUST NOT emit

- `schema_version`, `input_schema`, `output_schema`,
  `refReconAlgorithm` (canonical-only; canonicalize fills them).
  **Exception**: `code` nodes MAY emit `output_schema` to declare
  structured stdout fields.
- A spec-level `outputs[]` per-node array (doesn't exist)
- Internal-id fields like `inputs.id` for agents (canonicalize adds
  these from `inputs.name`)
- Any field at top level that isn't in the 8 universal slots
- Promoted-tool names (`generate_echarts_config`,
  `run_code_in_sandbox`, `extract_dataset_by_sql`) as `inputs.name`
  of a `tool` node — each has its own dedicated node type
- For `agent`: a nested `inputs.args` wrapper — `task` and
  `context` are flat siblings of `inputs.name`
- For `code`: both `inputs.code_text` and `inputs.code_file`
  (mutually exclusive)
- For `code` with `language: "javascript"`: any value for
  `inputs.datasets` (v1 JS runtime has no parquet reader)
- For `chart`: data values inside `inputs.config.dataset.source`
  in the saved-spec form. (The chat-time `generate_echarts_config`
  tool call is a separate contract — see §6.5.4.)
- camelCase keys
- String-interpolation refs (`"task": "Summarise: @nodes.1.result"`).
  Refs are atomic: a leaf is either a literal or a whole-field
  ref, never a template with embedded refs.
- Refs into JSON paths deeper than the upstream node's declared
  output field (e.g. `@nodes.0.results[3].value` — refs end at the
  field; deeper drilling happens inside the consumer's code)

### 9.3 LLM error-recovery loop

When `canonicalize` or `validate` rejects an LLM-authored spec:

1. The HTTP route returns the error envelope verbatim (code +
   human-readable message + `Did you mean: ...` suggestions)
2. The chat layer re-injects the error as a system message
3. The LLM re-emits with the correction
4. Retry up to a small bounded number of times (today: 2)

Because errors carry typo suggestions, the single-shot self-correction
success rate is high. Don't hide errors from the LLM "for cleanliness"
— they're a feature.

---

## 10. Evolution playbook

### 10.1 Adding an optional field to an existing node type

No version bump. Add to Zod, document here, ship. Place the new
field under `inputs` (never at top level).

### 10.2 Adding a required field (or breaking change)

1. Bump that node type's `schema_version` (e.g. `"1"` → `"2"`)
2. Register a new executor entry: `"<type>:2"` in `NODE_EXECUTORS`
3. Keep the `"<type>:1"` entry — old workflows still run on it
4. Write `upgrade.ts:upgrade<Type>V1ToV2(node)` if and when an
   admin chooses to migrate (not automatic)
5. Update LLM prompt fragments to emit the v2 shape going forward
6. Update this doc's section §6.x to show v2 as the canonical form,
   with a small "v1 legacy" note

### 10.3 Adding a brand-new node type

1. Add the type literal to `NodeTypeSchema`
2. Add `LLM<Type>NodeSchema` and `Canonical<Type>NodeSchema` (Zod)
3. Add `NODE_SCHEMA_VERSIONS.<type> = "1"` to `canonicalize.ts`
4. Add the `canonicalize<Type>Node` function
5. Register executor at `"<type>:1"` in `NODE_EXECUTORS`
6. Add §6.x section here with LLM-friendliness notes
7. Update the relevant LLM tool description so the LLM knows it
   exists (no UI catalog — LLM learns types from prompts)

### 10.4 Retiring a node type

Rare. Steps:

1. Mark deprecated in this doc (don't remove the section)
2. LLM prompts stop teaching it
3. Engine keeps the executor running for old workflows (forever, or
   until an explicit migration pass rewrites every persisted spec)

**Never** remove an executor entry as long as any persisted
workflow still references it.

---

## 11. Open questions

| # | Question | Where |
|---|---|---|
| Q1 | `@upstream.X` and `passthrough: true` sugar — ship or stay reserved? | §5.3 |
| Q2 | ~~Chart node v1 merge semantics~~ — **resolved as D39.B**: only `option.dataset.source` | §6.5 |
| Q3 | When a single workflow needs N chart views of the same data, do we (a) allow multiple `chart` nodes in one spec, (b) push to artifact-level multi-view, or (c) accept 1:1 and let users dup the workflow? | Open |
| Q4 | Should `condition` / `loop` nodes share the common shape (§4) or introduce a gateway-bucket variant à la BPMN? | Not designed |
| Q5 | `input_schema` JSON Schema subset — which keywords are in scope for v1? | Today: `type`, `properties`, `required`, `const`, `enum`, `oneOf`, `additionalProperties` |
| Q6 | ~~`code` node final design~~ — **resolved**: `inputs = { language, code_text \| code_file, datasets?, params? }`. Defaults `output_schema` uses snake_case (`exit_code`, `duration_ms`). v1 languages: `python` + `javascript`. JS cannot consume `datasets`. | §6.3 |
| Q7 | ~~`agent` node final design~~ — **resolved**: flat `inputs = { name, task, context? }` (no `args` wrapper); output canonical-fixed `{ result: string }` (supersedes D30). | §6.4 |
| Q8 | ~~`chart` node `config.dataset.source` placeholder~~ — **resolved**: LLM does NOT write `source`; engine creates / fills the `dataset` key entirely. `generate_echarts_config` tool description teaches the convention. | §6.5 |
| Q9 | Future: `modify_workflow` LLM tool contract — patches operate on `inputs` keys only (DAG-structure changes via a separate tool). Detail pending. | Designed-in-spirit, not built |

---

## 12. Related documents

| Doc | Role |
|---|---|
| [`workflow.md`](./workflow.md) | What's built today, runtime flow diagrams, status |
| [`workflow-architecture.md`](./workflow-architecture.md) | Decision log (D1 → D39), alternates considered |
| [`data-sources.md`](./data-sources.md) | SQL node's underlying data-source / DuckDB / parquet contract |
| [`sandbox.md`](./sandbox.md) | Code node's sandbox path / mount contract |
| [`runner-events.md`](./runner-events.md) | `workflow_node_*` event types emitted by the engine |
| [`prompts.md`](./prompts.md) | LLM prompt fragments that teach node authoring |
| [`AGENTS.md`](../AGENTS.md) | Project rules — cache invariants, RBAC, runtime boundary |
