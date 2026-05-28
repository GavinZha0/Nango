/**
 * Workflow spec — Zod schemas + inferred TypeScript types.
 *
 * Two related but distinct shapes:
 *
 *   - **LLM-emit form** (`LLMWorkflowSpecSchema`) — the minimal
 *     spec a Stage 2 `modify_workflow` tool call would emit.
 *     Engine fills derived fields at save time.
 *
 *   - **Canonical stored form** (`CanonicalWorkflowSpecSchema`) —
 *     what `workflow.spec` JSONB actually contains after save.
 *     Adds `type` bucket tag, derived `outputs[]` / schemas,
 *     `agentId` resolution, and the `refReconAlgorithm` tag.
 *
 * See `docs/workflow-architecture.md`:
 *   §5.0 Common node fields
 *   §5.1 Tool node + §5.2 Agent node
 *   §5.3 spec.outputs (top-level map; D28)
 *   §6.1 canonical example
 *   §6.2 node definition table
 *   §6.3 validation rules
 *
 * Design references:
 *   D6  — 3 LLM-facing buckets; frontend_tool excluded
 *   D7  — per-node description required
 *   D13 — agent node string format `<source> / <name>`
 *   D19 — output schema 3-tier source priority
 *   D26 — `refReconAlgorithm: 'ref_recon_v1'` tag in spec
 *   D27 — NodeType collapse to `'tool'` / `'agent'`; agentId
 *   D28 — spec.outputs as top-level `Record<key, RefString>` map
 *   D29 — numeric node ids
 *   D30 — agent node `output_schema` defaults to `{ text: string }`
 *         (when save pipeline captures a chat agent invocation)
 */

import { z } from "zod";

// ─── Time / retry helpers ──────────────────────────────────────────────

/**
 * Per-node retry configuration (D19, §5.0). All time units in
 * seconds — Nango persistence convention; engine converts to ms at
 * runtime via `getConfigMs()` or direct multiplication.
 */
export const RetriesSchema = z.object({
  attempts: z.number().int().nonnegative(),
  delaySeconds: z.number().int().nonnegative(),
  backoff: z.enum(["fixed", "exponential"]).optional(),
});

/**
 * Workflow-level execution overrides. All fields optional — engine
 * fills missing values from config keys at canonicalize time:
 *
 *   - `workflow.execution.default_max_parallelism`  (default: 3)
 *   - `workflow.execution.default_timeout`          (default: 60s)
 *   - `workflow.execution.hard_timeout`             (default: 1800s = 30 min)
 *   - `workflow.execution.default_on_failure`       (default: "stop")
 *
 * `timeoutSeconds` is capped at the hard limit by spec validation
 * (out of scope for this Zod schema; see `validate.ts`).
 */
export const ExecutionConfigSchema = z.object({
  max_parallelism: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  on_failure: z.enum(["stop", "continue"]).optional(),
});

// ─── Default agent output_schema (D30) ─────────────────────────────────

/**
 * Default `output_schema` for agent nodes whose schema the save
 * pipeline (`build-from-events.ts`, W2) cannot derive — i.e., agent
 * delegations captured from chat where the worker agent returned
 * natural language.
 *
 * The engine at runtime wraps the agent's natural-language reply as
 * `{ text: <reply> }` to match this shape. Downstream nodes
 * reference `@nodes.<id>.text`.
 *
 * V1.1+ may add observed-shape inference (D19 source 3) to detect
 * structured responses and bypass this default.
 */
export const DEFAULT_AGENT_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
} as const;

// ─── Node base + LLM-emit shapes ───────────────────────────────────────

/** Fields shared by every node bucket. */
const NodeBaseSchema = z.object({
  id: z.number().int().nonnegative(), // D29 numeric id
  description: z.string().min(1), // D7 required
  depends_on: z.array(z.number().int().nonnegative()),
  retries: RetriesSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

/**
 * V1.x node type enum (D35 + D36). Four buckets:
 *
 *   - `"tool"`  — server / MCP / HTTP / template tool (D27)
 *   - `"agent"` — `delegate_to_agent` (D13 / D27)
 *   - `"code"`  — sandboxed code execution (D35, supersedes
 *                 the `run_code_in_sandbox` tool node path);
 *                 first-class because the runtime, input
 *                 wiring (`inputs.datasets` mounting), and
 *                 output schema (declarable stdout JSON) all
 *                 differ from generic tools enough to warrant
 *                 explicit modelling.
 *   - `"sql"`   — data-extraction by SQL (D36, supersedes
 *                 the `extract_dataset_by_sql` tool node path);
 *                 first-class because the engine routes through
 *                 `data-sources/policy.ts` (parse + readonly
 *                 enforcement), L1 query cache, and writes a
 *                 Parquet snapshot that downstream `code` nodes
 *                 bind-mount by name. The "main body" of the
 *                 node is the `query` string, parallel to code's
 *                 `code` string — neither belongs in a generic
 *                 tool `input` map.
 *
 * The discriminator is explicit (`type: "tool" | "agent" | "code" | "sql"`)
 * on the LLM-emit form, not implicit-by-field-presence. Pre-D35
 * specs used field-presence discrimination (`tool` vs `agent`); pre-D36
 * specs used `tool: "extract_dataset_by_sql"`. Neither shape is
 * supported any more — `workflow.spec` rows from before D36 were
 * dropped via migration.
 */
export const NodeTypeSchema = z.enum(["tool", "agent", "code", "sql"]);

/**
 * Tool node — LLM-emit form. Single `{ type, tool, input }` shape
 * covers server tools, MCP tools, HTTP, template (D27). The `tool`
 * value is the literal `toolName` from the LLM's tool-call records
 * — no `mcp.` prefix or two-field server/tool split.
 *
 * `frontend_tool` (chart_renderer / render_html / render_markdown)
 * is NOT a valid `tool` value (D6); spec validation enforces this
 * at the registry-lookup stage. `run_code_in_sandbox` is ALSO not
 * a valid `tool` value any more (D35) — the save pipeline rewrites
 * those invocations to `type: "code"` nodes.
 */
export const LLMToolNodeSchema = NodeBaseSchema.extend({
  type: z.literal("tool"),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

/**
 * Agent node — LLM-emit form. `agent` follows the
 * `<sourceLabel> / <agentName>` format used by `delegate_to_agent`
 * (D13). `output_schema` is REQUIRED (agents have no registry-
 * declared output contract; D27).
 *
 * V1 save pipeline supplies `DEFAULT_AGENT_OUTPUT_SCHEMA` when
 * capturing chat agent invocations (D30).
 */
export const LLMAgentNodeSchema = NodeBaseSchema.extend({
  type: z.literal("agent"),
  agent: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
});

/**
 * V1.x supported sandbox languages (D35). Narrow on purpose:
 * production traffic is python only. Adding "node" / "bash" / "r"
 * means extending the engine's language→command table in
 * `nodes/code-node.ts` AND the save pipeline's command-prefix
 * detector in `build-from-events.ts::assembleCodeNode`. Both lift
 * the same lookup table; keep it short.
 */
export const CodeLanguageSchema = z.enum(["python"]);

/**
 * Code node — LLM-emit form (D35). Models a sandboxed code-execution
 * step distinct from generic tool nodes.
 *
 *   - `code`           — the snippet to execute, piped to the
 *                        sandbox's stdin. Non-empty.
 *   - `language`       — picks the interpreter (V1: python only).
 *   - `input`          — same shape as tool/agent's `input`.
 *                        Conventional keys the engine consumes:
 *                          `datasets`: string[] of dataset names
 *                            (or `@nodes.X.Y` refs) to expose
 *                            read-only at `./data/<name>/` in the
 *                            sandbox cwd.
 *                          `env`: Record<string,string> of env
 *                            vars to pass through (each may be a
 *                            literal or a ref). [V1.x — not yet
 *                            wired in the executor.]
 *                        Other keys are ignored by the engine but
 *                        kept around for the canonical spec /
 *                        admin forensics.
 *   - `output_schema`  — OPTIONAL JSON-Schema-ish description of
 *                        the JSON the code prints to stdout. When
 *                        present, the engine `JSON.parse(stdout)`
 *                        and exposes the parsed object's top-level
 *                        keys as `@nodes.X.<key>`. When ABSENT, the
 *                        node's outputs default to
 *                        `{ stdout, stderr, exitCode, durationMs }`
 *                        and downstream nodes ref `@nodes.X.stdout`.
 */
export const LLMCodeNodeSchema = NodeBaseSchema.extend({
  type: z.literal("code"),
  language: CodeLanguageSchema,
  code: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * SQL node — LLM-emit form (D36). Models a data-extraction step
 * distinct from generic tool nodes.
 *
 *   - `dataSourceName` — the `data_source.name` slug (the same
 *                        slug the extract_dataset_by_sql tool
 *                        accepts; LLM-facing identifier validated
 *                        by `data-sources/lookup.ts` at execute
 *                        time).
 *   - `query`          — the SQL text to run against the data
 *                        source. The engine parses it via
 *                        `data-sources/policy.ts` and rejects
 *                        writes / disallowed tables before
 *                        touching the cache.
 *   - `name`           — OPTIONAL output dataset slug (Parquet
 *                        cache key). When omitted, the engine
 *                        derives a deterministic slug from
 *                        `(workflowId, nodeId)`. Downstream code
 *                        nodes reference this value through
 *                        `@nodes.<id>.name` to expose the cached
 *                        Parquet read-only at `./data/<name>/` in
 *                        the sandbox cwd.
 *
 * Tool-level concerns (previewRows / forceRefresh) are NOT exposed
 * on the SQL node — they're chat-affordances of the
 * extract_dataset_by_sql tool that don't translate to workflow
 * semantics. The engine internally calls the tool with
 * `previewRows: 0, forceRefresh: false`; workflow-level "refresh"
 * is the artifact refresh path (`POST /api/artifacts/[id]/refresh`),
 * not a per-node flag.
 */
export const LLMSqlNodeSchema = NodeBaseSchema.extend({
  type: z.literal("sql"),
  dataSourceName: z.string().min(1),
  query: z.string().min(1),
  name: z.string().min(1).optional(),
});

/**
 * LLM-emit node — tool, agent, code, or sql (D35 + D36).
 * Discriminated union on the explicit `type` literal. Zod surfaces
 * a precise error when `type` is missing or doesn't match a
 * variant — no manual `isToolNode` / `isAgentNode` probing needed
 * downstream.
 */
export const LLMNodeSchema = z.discriminatedUnion("type", [
  LLMToolNodeSchema,
  LLMAgentNodeSchema,
  LLMCodeNodeSchema,
  LLMSqlNodeSchema,
]);

/**
 * Workflow spec — LLM-emit form. The minimal shape `modify_workflow`
 * (Stage 2) accepts and the save pipeline (Stage 1) produces before
 * canonicalization.
 */
export const LLMWorkflowSpecSchema = z.object({
  version: z.literal("1.0"),
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Workflow-level inputs (a JSON Schema 2020-12 subset; engine
   * validates user inputs at execute time). Untyped at the spec
   * layer — schema-of-schemas validation lives in `validate.ts`.
   */
  input_schema: z.record(z.string(), z.unknown()).optional(),
  nodes: z.array(LLMNodeSchema).min(1),
  /**
   * Top-level workflow outputs (D28) — `Record<key, RefString>`.
   * Each value is an `@nodes.<numeric-id>.<field>` ref string
   * (validated structurally in `validate.ts`, semantically by ref
   * reachability there too).
   */
  outputs: z.record(z.string(), z.string()).refine(
    (m) => Object.keys(m).length > 0,
    { message: "spec.outputs must contain at least one entry" },
  ),
  execution: ExecutionConfigSchema.optional(),
});

// ─── Canonical (stored) shapes ─────────────────────────────────────────

/**
 * Canonical tool node — LLM-emit shape + engine-derived fields.
 *
 *   `type`          — D27 bucket tag (always "tool"; sub-class
 *                     server-vs-MCP resolves at dispatch)
 *   `input_schema`  — derived from tool registry's `parameters`
 *   `outputs[]`     — derived via D19 3-tier priority (declared
 *                     `outputSchema` > observed > inferred)
 *   `output_schema` — same priority, structural form
 */
export const CanonicalToolNodeSchema = LLMToolNodeSchema.extend({
  input_schema: z.record(z.string(), z.unknown()).optional(),
  outputs: z.array(z.string()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Canonical agent node — LLM-emit shape + engine-derived fields.
 *
 *   `type`     — D27 bucket tag (always "agent")
 *   `agentId`  — UUID resolved from the `agent` string via
 *                EntityCatalog (D27); runtime dispatches via this
 *                UUID, never re-queries the catalog
 *   `outputs[]` — derived from `output_schema.required`
 */
export const CanonicalAgentNodeSchema = LLMAgentNodeSchema.extend({
  agentId: z.string().uuid(),
  outputs: z.array(z.string()).optional(),
});

/**
 * Default outputs[] for a code node whose `output_schema` is absent
 * (D35). Mirrors the `SandboxOutput` shape returned by every
 * sandbox adapter. Engine treats `stdout` as the canonical
 * downstream-referenceable field; richer schemas need an explicit
 * `output_schema` on the code node.
 */
export const DEFAULT_CODE_NODE_OUTPUTS: readonly string[] = [
  "stdout",
  "stderr",
  "exitCode",
  "durationMs",
] as const;

/**
 * Canonical code node — LLM-emit shape + engine-derived fields (D35).
 *
 *   `type`     — bucket tag (always "code")
 *   `outputs[]` — when LLM declared `output_schema`, derived from
 *                 `output_schema.properties` keys. Otherwise filled
 *                 with `DEFAULT_CODE_NODE_OUTPUTS` so downstream
 *                 `@nodes.X.stdout` refs validate at save time.
 */
export const CanonicalCodeNodeSchema = LLMCodeNodeSchema.extend({
  outputs: z.array(z.string()).optional(),
});

/**
 * Default outputs[] for a SQL node (D36). Mirrors the success
 * envelope returned by `extract_dataset_by_sql` after the engine
 * strips operational fields (cacheHit / ttlHours / schema / preview):
 *
 *   - `name`     — the Parquet dataset slug, downstream code nodes
 *                  reference via `@nodes.X.name` for bind-mounting
 *   - `rowCount` — row count of the extracted dataset, useful for
 *                  empty-result short-circuits in downstream code
 *
 * Other tool result fields (cacheHit, ttlHours, schema, preview)
 * are intentionally NOT exposed as referenceable outputs — they're
 * operational metadata that doesn't belong in the workflow data
 * flow. (`schema` is only populated on fresh extracts anyway, not
 * cache hits, so it's not a stable downstream contract.)
 */
export const DEFAULT_SQL_NODE_OUTPUTS: readonly string[] = [
  "name",
  "rowCount",
] as const;

/**
 * Canonical SQL node — LLM-emit shape + engine-derived fields (D36).
 *
 *   `type`     — bucket tag (always "sql")
 *   `outputs[]` — always filled with `DEFAULT_SQL_NODE_OUTPUTS`
 *                 by canonicalize so `@nodes.X.name` /
 *                 `@nodes.X.rowCount` validate at save time.
 */
export const CanonicalSqlNodeSchema = LLMSqlNodeSchema.extend({
  outputs: z.array(z.string()).optional(),
});

/**
 * Canonical node — discriminated on `type` since canonical form
 * always carries the bucket tag (filled at canonicalize time).
 */
export const CanonicalNodeSchema = z.discriminatedUnion("type", [
  CanonicalToolNodeSchema,
  CanonicalAgentNodeSchema,
  CanonicalCodeNodeSchema,
  CanonicalSqlNodeSchema,
]);

/**
 * Canonical workflow spec — what `workflow.spec` JSONB holds.
 *
 * Extends LLM-emit form with:
 *   - canonical `nodes` (with `type`, `agentId`, derived schemas)
 *   - top-level `output_schema` derived from the outputs map's
 *     ref targets
 *   - `refReconAlgorithm` tag (D26 — tracks save-time ref
 *     reconstruction algorithm version for V2 re-capture path)
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

/** V1.x node type enum (D27 + D28 + D35 + D36). */
export type NodeType = z.infer<typeof NodeTypeSchema>;
