/**
 * Workflow spec — Zod schemas + inferred TypeScript types.
 *
 * Two shapes:
 *  - `LLMWorkflowSpecSchema`        — minimal form the LLM emits
 *  - `CanonicalWorkflowSpecSchema`  — stored form after canonicalize
 *
 * See docs/workflow.md.
 */

import { z } from "zod";

// ─── Time / retry helpers ──────────────────────────────────────────────

/** Per-node retry configuration. All time units in seconds. */
export const RetriesSchema = z.object({
  attempts: z.number().int().nonnegative(),
  delaySeconds: z.number().int().nonnegative(),
  backoff: z.enum(["fixed", "exponential"]).optional(),
});

/**
 * Workflow-level execution overrides. Missing values are filled from
 * the `workflow.execution.*` config keys at canonicalize time.
 * `timeoutSeconds` is capped at the hard limit by `validate.ts`.
 */
export const ExecutionConfigSchema = z.object({
  max_parallelism: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  on_failure: z.enum(["stop", "continue"]).optional(),
});

// ─── Default agent output_schema ───────────────────────────────────────

/**
 * Default `output_schema` for agent nodes whose schema the save
 * pipeline cannot derive (typical for chat agent delegations).
 * The engine wraps the agent's natural-language reply as
 * `{ text: <reply> }` so downstream nodes can reference
 * `@nodes.<id>.text`.
 */
export const DEFAULT_AGENT_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
} as const;

// ─── Node base + LLM-emit shapes ───────────────────────────────────────

/** Fields shared by every node bucket. */
const NodeBaseSchema = z.object({
  id: z.number().int().nonnegative(),
  description: z.string().min(1),
  depends_on: z.array(z.number().int().nonnegative()),
  retries: RetriesSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

/** Node type discriminator. See docs/workflow.md. */
export const NodeTypeSchema = z.enum(["tool", "agent", "code", "sql"]);

/**
 * Tool node — LLM-emit form. Covers server tools, MCP tools, HTTP,
 * and template tools. `tool` is the literal `toolName` from the
 * LLM's tool-call records (no prefix or two-field split).
 * `frontend_tool` values and `run_code_in_sandbox` are rejected at
 * spec validation — frontend tools have no workflow semantics and
 * sandboxed code is modelled as a first-class `code` node.
 */
export const LLMToolNodeSchema = NodeBaseSchema.extend({
  type: z.literal("tool"),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

/**
 * Agent node — LLM-emit form. `agent` follows the
 * `<sourceLabel> / <agentName>` format used by `delegate_to_agent`.
 * `output_schema` is REQUIRED (agents have no registry-declared
 * output contract). The save pipeline supplies
 * `DEFAULT_AGENT_OUTPUT_SCHEMA` when capturing chat delegations.
 */
export const LLMAgentNodeSchema = NodeBaseSchema.extend({
  type: z.literal("agent"),
  agent: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
});

/**
 * Sandbox languages. Narrow on purpose — adding a language means
 * extending the engine's language→command table in
 * `nodes/code-node.ts` AND the save pipeline's command-prefix
 * detector in `build-from-events.ts`. Both lift the same lookup;
 * keep it short.
 */
export const CodeLanguageSchema = z.enum(["python"]);

/**
 * Code node — LLM-emit form. A sandboxed code-execution step.
 *
 *  - `code`           snippet piped to the sandbox stdin (non-empty)
 *  - `language`       picks the interpreter
 *  - `input`          same shape as tool/agent's `input`. Conventional
 *                     keys the engine consumes:
 *                       `datasets`: string[] of dataset names (or
 *                         `@nodes.X.Y` refs) to expose read-only at
 *                         `./data/<name>/` in the sandbox cwd.
 *                       `env`: Record<string,string> of env vars.
 *                     Other keys are ignored at runtime but preserved.
 *  - `output_schema`  optional JSON-Schema-ish description of the JSON
 *                     the code prints to stdout. When present, the
 *                     engine `JSON.parse(stdout)` and exposes the
 *                     parsed object's top-level keys as
 *                     `@nodes.X.<key>`. When ABSENT, outputs default
 *                     to `{ stdout, stderr, exitCode, durationMs }`.
 */
export const LLMCodeNodeSchema = NodeBaseSchema.extend({
  type: z.literal("code"),
  language: CodeLanguageSchema,
  code: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * SQL node — LLM-emit form. A data-extraction step.
 *
 *  - `dataSourceName`  the `data_source.name` slug
 *  - `query`           SQL text run against the data source; the
 *                      engine routes through `data-sources/policy.ts`
 *                      which rejects writes / disallowed tables
 *                      before touching the cache
 *  - `name`            OPTIONAL output dataset slug (Parquet cache
 *                      key). When omitted, the engine derives a
 *                      deterministic slug from `(workflowId, nodeId)`.
 *                      Downstream code nodes reference via
 *                      `@nodes.<id>.name`.
 *
 * Tool-level affordances (previewRows / forceRefresh) are NOT
 * exposed — refresh is the artifact-level concern.
 */
export const LLMSqlNodeSchema = NodeBaseSchema.extend({
  type: z.literal("sql"),
  dataSourceName: z.string().min(1),
  query: z.string().min(1),
  name: z.string().min(1).optional(),
});

/** LLM-emit node — discriminated union on `type`. */
export const LLMNodeSchema = z.discriminatedUnion("type", [
  LLMToolNodeSchema,
  LLMAgentNodeSchema,
  LLMCodeNodeSchema,
  LLMSqlNodeSchema,
]);

/** Workflow spec — LLM-emit form. */
export const LLMWorkflowSpecSchema = z.object({
  version: z.literal("1.0"),
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Workflow-level inputs (a JSON Schema 2020-12 subset). Schema-of-
   * schemas validation lives in `validate.ts`.
   */
  input_schema: z.record(z.string(), z.unknown()).optional(),
  nodes: z.array(LLMNodeSchema).min(1),
  /**
   * Top-level workflow outputs — `Record<key, RefString>`. Each value
   * is an `@nodes.<numeric-id>.<field>` ref string. Structural and
   * reachability validation in `validate.ts`.
   */
  outputs: z.record(z.string(), z.string()).refine(
    (m) => Object.keys(m).length > 0,
    { message: "spec.outputs must contain at least one entry" },
  ),
  execution: ExecutionConfigSchema.optional(),
});

// ─── Canonical (stored) shapes ─────────────────────────────────────────

/**
 * Canonical tool node — adds engine-derived fields:
 *  - `input_schema`  derived from the tool registry's `parameters`
 *  - `outputs[]`     derived via the declared / observed / inferred
 *                    priority chain
 *  - `output_schema` structural form of the same
 */
export const CanonicalToolNodeSchema = LLMToolNodeSchema.extend({
  input_schema: z.record(z.string(), z.unknown()).optional(),
  outputs: z.array(z.string()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Canonical agent node — adds:
 *  - `agentId`   UUID resolved from `agent` via EntityCatalog at save
 *                time; runtime dispatches via this UUID
 *  - `outputs[]` derived from `output_schema.required`
 */
export const CanonicalAgentNodeSchema = LLMAgentNodeSchema.extend({
  agentId: z.string().uuid(),
  outputs: z.array(z.string()).optional(),
});

/**
 * Default outputs[] for a code node whose `output_schema` is absent.
 * Mirrors the `SandboxOutput` shape returned by every sandbox
 * adapter.
 */
export const DEFAULT_CODE_NODE_OUTPUTS: readonly string[] = [
  "stdout",
  "stderr",
  "exitCode",
  "durationMs",
] as const;

/**
 * Canonical code node — `outputs[]` is either derived from the
 * declared `output_schema.properties` keys, or filled with
 * `DEFAULT_CODE_NODE_OUTPUTS`.
 */
export const CanonicalCodeNodeSchema = LLMCodeNodeSchema.extend({
  outputs: z.array(z.string()).optional(),
});

/**
 * Default outputs[] for a SQL node — the slim subset of the
 * `extract_dataset_by_sql` envelope that is meaningful for workflow
 * data flow:
 *  - `name`      Parquet dataset slug; code nodes bind-mount by this
 *  - `rowCount`  row count, for empty-result short-circuits
 *
 * Operational fields (cacheHit / ttlHours / schema / preview) are
 * intentionally not exposed.
 */
export const DEFAULT_SQL_NODE_OUTPUTS: readonly string[] = [
  "name",
  "rowCount",
] as const;

/** Canonical SQL node — `outputs[]` is always filled with `DEFAULT_SQL_NODE_OUTPUTS`. */
export const CanonicalSqlNodeSchema = LLMSqlNodeSchema.extend({
  outputs: z.array(z.string()).optional(),
});

/** Canonical node — discriminated on `type`. */
export const CanonicalNodeSchema = z.discriminatedUnion("type", [
  CanonicalToolNodeSchema,
  CanonicalAgentNodeSchema,
  CanonicalCodeNodeSchema,
  CanonicalSqlNodeSchema,
]);

/**
 * Canonical workflow spec — what `workflow.spec` JSONB holds.
 *
 * Extends LLM-emit form with canonical `nodes`, derived
 * `output_schema`, and the `refReconAlgorithm` tag (tracks the
 * save-time ref reconstruction algorithm version).
 */
export const CanonicalWorkflowSpecSchema = LLMWorkflowSpecSchema.extend({
  nodes: z.array(CanonicalNodeSchema).min(1),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  refReconAlgorithm: z.literal("ref_recon_v1"),
});

// ─── Inferred TypeScript types ─────────────────────────────────────────

export type Retries = z.infer<typeof RetriesSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export type LLMToolNode = z.infer<typeof LLMToolNodeSchema>;
export type LLMAgentNode = z.infer<typeof LLMAgentNodeSchema>;
export type LLMCodeNode = z.infer<typeof LLMCodeNodeSchema>;
export type LLMSqlNode = z.infer<typeof LLMSqlNodeSchema>;
export type LLMNode = z.infer<typeof LLMNodeSchema>;
export type LLMWorkflowSpec = z.infer<typeof LLMWorkflowSpecSchema>;
export type CodeLanguage = z.infer<typeof CodeLanguageSchema>;

export type CanonicalToolNode = z.infer<typeof CanonicalToolNodeSchema>;
export type CanonicalAgentNode = z.infer<typeof CanonicalAgentNodeSchema>;
export type CanonicalCodeNode = z.infer<typeof CanonicalCodeNodeSchema>;
export type CanonicalSqlNode = z.infer<typeof CanonicalSqlNodeSchema>;
export type CanonicalNode = z.infer<typeof CanonicalNodeSchema>;
export type CanonicalWorkflowSpec = z.infer<typeof CanonicalWorkflowSpecSchema>;

export type NodeType = z.infer<typeof NodeTypeSchema>;
