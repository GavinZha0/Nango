/**
 * Workflow spec — Zod schemas + inferred TypeScript types.
 *
 * Responsibility
 * --------------
 * This file is the TypeScript / Zod world: type definitions, runtime
 * spec parsing, and compile-time type safety. It has ONE job — define
 * the shape of what is STORED in `workflow.spec` (JSONB) and give
 * TypeScript consumers precise types to work with.
 *
 * What lives here:
 *   - LLM-emit Zod schemas  (input validation at save time)
 *   - Canonical Zod schemas (what the engine and validator read)
 *   - TypeScript types derived from those schemas
 *
 * What does NOT live here:
 *   - JSON Schema constants for LLM prompts / UI / self-description
 *     → those live in `../nodes/registry.ts`
 *   - Per-node runtime output envelopes
 *     → those live in `../nodes/registry.ts`
 *
 * Two shapes per node type
 * ------------------------
 *   LLM-emit:  the minimal form the LLM writes (display names, no UUIDs,
 *              no canonicalize-derived fields). Validated at save time.
 *   Canonical: the stored form after canonicalize.ts has run (UUIDs
 *              resolved, schema_version stamped). What the engine reads.
 *
 * Canonical inputs schemas carry `.describe()` and `.meta()` annotations.
 * These are consumed by `registry.ts` via `z.toJSONSchema()` to derive
 * the JSON Schema used for LLM prompts and UI form generation, without
 * duplicating field descriptions between Zod and JSON Schema.
 *
 * See docs/workflow.md.
 */

import { z } from "zod";

// ─── Shared helpers ────────────────────────────────────────────────────

/** Per-node retry configuration. All time units in seconds. */
export const RetriesSchema = z.object({
  attempts: z.number().int().nonnegative(),
  delay_seconds: z.number().int().nonnegative(),
  backoff: z.enum(["fixed", "exponential"]).optional(),
});

/**
 * Workflow-level execution overrides. Missing values are filled from
 * the `workflow.execution.*` config keys at canonicalize time.
 * `timeout_seconds` is capped at the hard limit by `validate.ts`.
 */
export const ExecutionConfigSchema = z.object({
  max_parallelism: z.number().int().positive().optional(),
  timeout_seconds: z.number().int().positive().optional(),
  on_failure: z.enum(["stop", "continue"]).optional(),
});

// ─── Base node fields (shared by all node types) ───────────────────────

/** Fields present on every node regardless of type. */
const NodeBaseSchema = z.object({
  id: z.number().int().nonnegative(),
  description: z.string().optional(),
  depends_on: z.array(z.number().int().nonnegative()),
  retries: RetriesSchema.optional(),
  timeout_seconds: z.number().int().positive().optional(),
});

/** Node type discriminator. See docs/workflow.md. */
export const NodeTypeSchema = z.enum(["tool", "agent", "code", "sql", "chart"]);

/** Chart renderer libraries supported by the chart node. */
export const ChartRendererSchema = z.enum(["echarts"]);

/**
 * Chart node `inputs.dataset` — either a single `@path` ref or an
 * array of ≥2 refs for a multi-dataset chart.
 */
export const ChartDatasetRefSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(2),
]);

/** Sandbox languages supported in v1. */
export const CodeLanguageSchema = z.enum(["python", "javascript"]);

// ─── LLM-emit schemas ──────────────────────────────────────────────────
//
// Minimal forms the LLM writes. Validated at save time. No UUIDs,
// no schema_version, no canonicalize-derived fields.

export const LLMToolNodeSchema = NodeBaseSchema.extend({
  type: z.literal("tool"),
  inputs: z.object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  }),
});

export const LLMAgentNodeSchema = NodeBaseSchema.extend({
  type: z.literal("agent"),
  inputs: z.object({
    name: z.string().min(1),
    task: z.string().min(1),
    context: z.string().min(1).optional(),
  }),
});

export const LLMCodeNodeSchema = NodeBaseSchema.extend({
  type: z.literal("code"),
  inputs: z.object({
    language: CodeLanguageSchema,
    code_text: z.string().min(1).optional(),
    code_file: z.string().min(1).optional(),
    datasets: z.array(z.unknown()).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  // output_schema removed: code nodes use the fixed CodeOutputEnvelope
  // contract (rows, row_count, row_schema, message, files, error).
  // assembleCodeOutput() in sandbox/code-output.ts handles stdout parsing.
});

export const LLMSqlNodeSchema = NodeBaseSchema.extend({
  type: z.literal("sql"),
  inputs: z.object({
    data_source_name: z.string().min(1),
    sql_text: z.string().min(1),
    dataset_name: z.string().min(1).optional(),
    row_limit: z.number().int().min(0).max(200).optional(),
  }),
});

export const LLMChartNodeSchema = NodeBaseSchema.extend({
  type: z.literal("chart"),
  inputs: z.object({
    renderer: ChartRendererSchema,
    config: z.record(z.string(), z.unknown()),
    dataset: ChartDatasetRefSchema.optional(),
  }),
});

/** LLM-emit node — discriminated union on `type`. */
export const LLMNodeSchema = z.discriminatedUnion("type", [
  LLMToolNodeSchema,
  LLMAgentNodeSchema,
  LLMCodeNodeSchema,
  LLMSqlNodeSchema,
  LLMChartNodeSchema,
]);

/** Workflow spec — LLM-emit form. */
export const LLMWorkflowSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  nodes: z.array(LLMNodeSchema).min(1),
  outputs: z.record(z.string(), z.string()).refine(
    (m) => Object.keys(m).length > 0,
    { message: "spec.outputs must contain at least one entry" },
  ),
  execution: ExecutionConfigSchema.optional(),
});

// ─── Canonical (stored) schemas ────────────────────────────────────────
//
// What the engine reads after canonicalize.ts has run. Each non-tool
// canonical schema differs from its LLM-emit counterpart only in:
//   - `schema_version` (stamped by canonicalize)
//   - Resolved UUID fields (e.g. `inputs.data_source_id`)
//
// Stamped metadata (input_schema / output_schema / outputs[]) has been
// removed from canonical node instances and moved to the type registry
// (`../nodes/registry.ts`). The engine and validator look up type-level
// schema information from the registry by (type, schema_version).
//
// Exception: `CanonicalToolNodeSchema` keeps input_schema / output_schema
// / outputs[] because tool nodes have DYNAMIC, per-tool schemas that
// are snapshotted at save time to protect against tool contract changes.

/**
 * Per-node schema version. Stamped by `canonicalize.ts`.
 * Bump when a node type has a breaking schema change; the engine
 * dispatches executors by (type, schema_version) to keep old
 * persisted workflows runnable.
 */
export const NodeSchemaVersionV1Schema = z.literal("1").default("1");

// ── Tool node (dynamic schema — stays per-instance) ──────────────────

/**
 * Canonical tool node. Unlike all other canonical nodes, tool nodes
 * retain `input_schema`, `output_schema`, and `outputs[]` as
 * per-instance fields. Rationale: each tool has a different schema
 * (from the tool registry), and that schema is snapshotted at save
 * time so the workflow is protected against tool contract changes
 * between save and refresh.
 */
export const CanonicalToolNodeSchema = LLMToolNodeSchema.extend({
  schema_version: NodeSchemaVersionV1Schema,
  /** Snapshotted from the tool registry at save time. Used for AJV
   *  input validation at execute time. */
  input_schema: z.record(z.string(), z.unknown()).optional(),
  /** Snapshotted from the tool registry at save time. Used for AJV
   *  output validation at execute time. */
  output_schema: z.record(z.string(), z.unknown()).optional(),
  /** Field names derived from output_schema at save time. Used by
   *  validate.ts for @nodes.X.field ref checks until P1 migration. */
  outputs: z.array(z.string()).optional(),
});

// ── Agent node ───────────────────────────────────────────────────────

/**
 * Canonical inputs for agent nodes.
 *
 * Exported separately so `registry.ts` can derive the JSON Schema via
 * `z.toJSONSchema()` without duplicating field descriptions.
 *
 * `inputs.agent_id` is `x-canonical-only`: it is resolved from
 * `inputs.name` by canonicalize via EntityCatalog and is NOT written
 * by LLMs or human editors.
 */
export const CanonicalAgentInputsSchema = z.object({
  name: z.string().min(1).describe(
    "Agent display string in <sourceLabel> / <agentName> format. " +
    "Canonicalize resolves this to agent_id (UUID) via EntityCatalog.",
  ),
  agent_id: z.string().uuid()
    .meta({ "x-canonical-only": true })
    .describe(
      "UUID resolved from `name` by canonicalize. " +
      "LLMs and human editors do NOT write this field.",
    ),
  task: z.string().min(1).describe(
    "Direct instruction to the agent. A free-form prompt or a single " +
    "@path ref to an upstream string output. String interpolation " +
    "(e.g. 'Summarise: @nodes.1.result') is NOT supported in v1.",
  ),
  context: z.string().min(1).optional().describe(
    "Optional background context passed alongside the task. " +
    "Same value rules as `task`.",
  ),
});

export const CanonicalAgentNodeSchema = NodeBaseSchema.extend({
  type: z.literal("agent"),
  schema_version: NodeSchemaVersionV1Schema,
  inputs: CanonicalAgentInputsSchema,
  // input_schema / output_schema / outputs[] removed (P2).
  // Consumed from NODE_TYPE_REGISTRY["agent:1"] by validate.ts (P1).
});

// ── Code node ────────────────────────────────────────────────────────

/**
 * Canonical inputs for code nodes.
 *
 * Exported separately for `registry.ts` JSON Schema derivation.
 * No canonical-only fields — the LLM writes all inputs as-is.
 */
export const CanonicalCodeInputsSchema = z.object({
  language: CodeLanguageSchema.describe(
    "Interpreter. python: full support (code_text, code_file, datasets, params). " +
    "javascript: code_text only (no datasets in v1 Node.js runtime).",
  ),
  code_text: z.string().min(1).optional().describe(
    "Inline source text piped to the sandbox via stdin. " +
    "Mutually exclusive with code_file.",
  ),
  code_file: z.string().min(1).optional().describe(
    "Path relative to ./code/ in the sandbox cwd. Python only. " +
    "Mutually exclusive with code_text.",
  ),
  datasets: z.array(z.unknown()).optional().describe(
    "Dataset names or @nodes.X.dataset_name refs. Mounted read-only " +
    "at ./data/<name>/ in sandbox cwd. Python only.",
  ),
  params: z.record(z.string(), z.unknown()).optional().describe(
    "Runtime parameters. Serialized into NANGO_PARAMS env var; " +
    "read via os.environ['NANGO_PARAMS'] (Python) or process.env (JS).",
  ),
});

export const CanonicalCodeNodeSchema = NodeBaseSchema.extend({
  type: z.literal("code"),
  schema_version: NodeSchemaVersionV1Schema,
  inputs: CanonicalCodeInputsSchema,
  // output_schema removed (Stage 2). Code nodes now return the fixed
  // CodeOutputEnvelope; see sandbox/code-output.ts and registry.ts.
});

// ── SQL node ─────────────────────────────────────────────────────────

/**
 * Canonical inputs for SQL nodes.
 *
 * Exported separately for `registry.ts` JSON Schema derivation.
 * `inputs.data_source_id` is `x-canonical-only`: resolved from
 * `data_source_name` by canonicalize; LLMs write only the slug.
 */
export const CanonicalSqlInputsSchema = z.object({
  data_source_name: z.string().min(1).describe(
    "Data source slug (human-readable name in the 'Available data sources' block). " +
    "LLMs write the slug; canonicalize resolves it to data_source_id (UUID).",
  ),
  data_source_id: z.string().uuid()
    .meta({ "x-canonical-only": true })
    .describe(
      "UUID resolved from data_source_name by canonicalize. " +
      "LLMs and human editors do NOT write this field.",
    ),
  sql_text: z.string().min(1).describe(
    "DuckDB-dialect SQL query. @inputs.* and @nodes.* refs are resolved " +
    "before execution. Writes and disallowed-table queries are blocked by " +
    "the data-source policy layer.",
  ),
  dataset_name: z.string().min(1).optional().describe(
    "Parquet cache slot name. Downstream code/chart nodes mount the result " +
    "read-only at ./data/<name>/ in sandbox cwd. Optional — engine derives " +
    "a deterministic name from (workflowId, nodeId) when omitted. " +
    "Last-write-wins: re-running with the same name replaces the cached dataset.",
  ),
  row_limit: z.number().int().min(0).max(200).optional().describe(
    "Maximum number of rows for preview. Defaults to 200 if not specified.",
  ),
});

export const CanonicalSqlNodeSchema = NodeBaseSchema.extend({
  type: z.literal("sql"),
  schema_version: NodeSchemaVersionV1Schema,
  inputs: CanonicalSqlInputsSchema,
  // outputs[] removed (P2). Consumed from NODE_TYPE_REGISTRY["sql:1"].
});

// ── Chart node ───────────────────────────────────────────────────────

/**
 * Canonical inputs for chart nodes.
 *
 * Exported separately for `registry.ts` JSON Schema derivation.
 * No canonical-only fields in v1. (In earlier versions, canonicalize
 * const-pinned `renderer` via a per-instance `input_schema`; with P2
 * that stamp is removed and the registry holds the generic enum form.)
 */
export const CanonicalChartInputsSchema = z.object({
  renderer: ChartRendererSchema.describe(
    "Chart renderer library. v1: echarts only. Future: plotly, vega, …",
  ),
  config: z.record(z.string(), z.unknown()).describe(
    "ECharts option TEMPLATE — no inline data. The engine fills " +
    "config.dataset[i].source from inputs.dataset at execute time. " +
    "Any @path ref inside config (other than inputs.dataset) is rejected " +
    "at save time with CHART_CONFIG_CONTAINS_REF.",
  ),
  dataset: ChartDatasetRefSchema.optional().describe(
    "@path ref (single) or array of refs (multi-dataset, ≥2). " +
    "Optional — when absent the config contains baked-in inline data " +
    "(not-refreshable fallback).",
  ),
});

export const CanonicalChartNodeSchema = NodeBaseSchema.extend({
  type: z.literal("chart"),
  schema_version: NodeSchemaVersionV1Schema,
  inputs: CanonicalChartInputsSchema,
  // input_schema / output_schema / outputs[] removed (P2).
});

// ── Discriminated unions ─────────────────────────────────────────────

/** Canonical node — discriminated on `type`. */
export const CanonicalNodeSchema = z.discriminatedUnion("type", [
  CanonicalToolNodeSchema,
  CanonicalAgentNodeSchema,
  CanonicalCodeNodeSchema,
  CanonicalSqlNodeSchema,
  CanonicalChartNodeSchema,
]);

/** Canonical workflow spec — what `workflow.spec` JSONB holds. */
export const CanonicalWorkflowSpecSchema = LLMWorkflowSpecSchema.extend({
  nodes: z.array(CanonicalNodeSchema).min(1),
});

// ─── Inferred TypeScript types ─────────────────────────────────────────

export type Retries = z.infer<typeof RetriesSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type NodeType = z.infer<typeof NodeTypeSchema>;
export type CodeLanguage = z.infer<typeof CodeLanguageSchema>;
export type ChartRenderer = z.infer<typeof ChartRendererSchema>;
export type ChartDatasetRef = z.infer<typeof ChartDatasetRefSchema>;

export type LLMToolNode = z.infer<typeof LLMToolNodeSchema>;
export type LLMAgentNode = z.infer<typeof LLMAgentNodeSchema>;
export type LLMCodeNode = z.infer<typeof LLMCodeNodeSchema>;
export type LLMSqlNode = z.infer<typeof LLMSqlNodeSchema>;
export type LLMChartNode = z.infer<typeof LLMChartNodeSchema>;
export type LLMNode = z.infer<typeof LLMNodeSchema>;
export type LLMWorkflowSpec = z.infer<typeof LLMWorkflowSpecSchema>;

export type CanonicalToolNode = z.infer<typeof CanonicalToolNodeSchema>;
export type CanonicalAgentNode = z.infer<typeof CanonicalAgentNodeSchema>;
export type CanonicalCodeNode = z.infer<typeof CanonicalCodeNodeSchema>;
export type CanonicalSqlNode = z.infer<typeof CanonicalSqlNodeSchema>;
export type CanonicalChartNode = z.infer<typeof CanonicalChartNodeSchema>;
export type CanonicalNode = z.infer<typeof CanonicalNodeSchema>;
export type CanonicalWorkflowSpec = z.infer<typeof CanonicalWorkflowSpecSchema>;
