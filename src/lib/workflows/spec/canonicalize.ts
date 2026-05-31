/**
 * LLM-emit spec → Canonical stored spec.
 *
 * Per-node enrichment:
 *   - Tool nodes: hydrate `input_schema` / `output_schema` /
 *     `outputs[]` from the registry.
 *   - Agent nodes: resolve `<source> / <name>` display strings to
 *     UUIDs via EntityCatalog; derive `outputs[]` from
 *     `output_schema.required`.
 *   - Code / SQL nodes: derive or default `outputs[]`.
 *   - Stamp `refReconAlgorithm: "ref_recon_v1"`.
 *
 * Failure mode: every problem throws a `WorkflowError`. The surrounding
 * save pipeline calls `toResult(we)` at its catch boundary.
 *
 * Out of scope: DAG validation / cycle detection (`validate.ts`),
 * deterministic spec hash (`hash.ts`), default timeout / retries /
 * parallelism (engine reads config keys at execute time so workflows
 * stay live under operator retuning).
 *
 * See docs/workflow.md.
 */

import { WorkflowError } from "../error";
import {
  type CanonicalAgentNode,
  type CanonicalCodeNode,
  type CanonicalNode,
  type CanonicalSqlNode,
  type CanonicalToolNode,
  type CanonicalWorkflowSpec,
  DEFAULT_CODE_NODE_OUTPUTS,
  DEFAULT_SQL_NODE_OUTPUTS,
  type LLMAgentNode,
  type LLMCodeNode,
  type LLMNode,
  type LLMSqlNode,
  type LLMToolNode,
  type LLMWorkflowSpec,
} from "./schema";

// ─── Dependencies ──────────────────────────────────────────────────────

/**
 * Tool-registry view that canonicalize needs. Fields are optional —
 * MCP tools whose server is offline at save time may ship with only
 * partial metadata; the engine surfaces `TOOL_INPUT_SCHEMA_MISMATCH`
 * at execute time if validation later fails.
 */
export interface ToolMetadata {
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  outputs?: readonly string[];
}

/** Lookups canonicalize delegates to its caller. */
export interface CanonicalizeDeps {
  /** Returns null if the tool name is unknown to the registry. */
  getToolMetadata(toolName: string): ToolMetadata | null;
  /**
   * Resolves an `<sourceLabel> / <agentName>` display string to its
   * UUID. Returns null if the agent no longer exists in EntityCatalog
   * or has been disabled.
   */
  resolveAgentId(displayString: string): string | null;
}

/** Current save-time ref reconstruction algorithm version. */
export const REF_RECON_ALGORITHM = "ref_recon_v1" as const;

// ─── Per-node canonicalization ─────────────────────────────────────────

/**
 * Derive a node's `outputs[]` list from a JSON-Schema-shaped
 * `output_schema`. `required-only` mode (tool / agent nodes) uses
 * `output_schema.required` as authoritative. `code` mode falls back
 * to `properties` keys when `required` is absent — code nodes
 * commonly declare a schema without `required` because the contract
 * is "stdout prints exactly these keys".
 *
 * Returns `undefined` when neither source has usable data.
 */
function deriveOutputsFromSchema(
  schema: Record<string, unknown> | undefined,
  mode: "required-only" | "code" = "required-only",
): string[] | undefined {
  if (schema === undefined) return undefined;
  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const fields = required.filter((s): s is string => typeof s === "string");
    if (fields.length > 0) return fields;
  }
  if (mode === "code") {
    const properties = (schema as { properties?: unknown }).properties;
    if (
      properties !== null &&
      typeof properties === "object" &&
      !Array.isArray(properties)
    ) {
      const keys = Object.keys(properties as Record<string, unknown>);
      if (keys.length > 0) return keys;
    }
  }
  return undefined;
}

function canonicalizeToolNode(
  n: LLMToolNode,
  deps: CanonicalizeDeps,
): CanonicalToolNode {
  const meta = deps.getToolMetadata(n.tool);
  if (meta === null) {
    throw new WorkflowError({
      errorCode: "TOOL_NOT_FOUND",
      message: `Node ${n.id}: tool '${n.tool}' is not registered.`,
      nodeId: n.id,
      nodeName: n.tool,
    });
  }
  const canonical: CanonicalToolNode = { ...n };
  if (meta.input_schema !== undefined) canonical.input_schema = meta.input_schema;
  if (meta.output_schema !== undefined) canonical.output_schema = meta.output_schema;
  const outputs =
    meta.outputs !== undefined && meta.outputs.length > 0
      ? [...meta.outputs]
      : deriveOutputsFromSchema(meta.output_schema);
  if (outputs !== undefined) canonical.outputs = outputs;
  return canonical;
}

function canonicalizeAgentNode(
  n: LLMAgentNode,
  deps: CanonicalizeDeps,
): CanonicalAgentNode {
  const agentId = deps.resolveAgentId(n.agent);
  if (agentId === null) {
    throw new WorkflowError({
      errorCode: "AGENT_NOT_FOUND",
      message: `Node ${n.id}: agent '${n.agent}' could not be resolved to a known catalog entry.`,
      nodeId: n.id,
      nodeName: n.agent,
    });
  }
  const canonical: CanonicalAgentNode = { ...n, agentId };
  const outputs = deriveOutputsFromSchema(n.output_schema);
  if (outputs !== undefined) canonical.outputs = outputs;
  return canonical;
}

/**
 * Canonicalize a code node. When `output_schema` is declared, derive
 * `outputs[]` from `properties` (or `required`) so downstream
 * `@nodes.X.<key>` refs can be ref-validated at save time. Otherwise
 * fall back to `DEFAULT_CODE_NODE_OUTPUTS`.
 */
function canonicalizeCodeNode(n: LLMCodeNode): CanonicalCodeNode {
  const canonical: CanonicalCodeNode = { ...n };
  const declared = deriveOutputsFromSchema(n.output_schema, "code");
  canonical.outputs =
    declared !== undefined ? declared : [...DEFAULT_CODE_NODE_OUTPUTS];
  return canonical;
}

/**
 * Canonicalize a SQL node. Fixed-shape contract: outputs are always
 * `DEFAULT_SQL_NODE_OUTPUTS`. The `dataSourceName` slug is NOT
 * resolved against `data_source` at save time — that lookup is
 * deferred to runtime so a temporarily-disabled data source doesn't
 * block the save.
 */
function canonicalizeSqlNode(n: LLMSqlNode): CanonicalSqlNode {
  const canonical: CanonicalSqlNode = { ...n };
  canonical.outputs = [...DEFAULT_SQL_NODE_OUTPUTS];
  return canonical;
}

function canonicalizeNode(
  n: LLMNode,
  deps: CanonicalizeDeps,
): CanonicalNode {
  switch (n.type) {
    case "tool":
      return canonicalizeToolNode(n, deps);
    case "agent":
      return canonicalizeAgentNode(n, deps);
    case "code":
      return canonicalizeCodeNode(n);
    case "sql":
      return canonicalizeSqlNode(n);
  }
}

// ─── Public entrypoint ─────────────────────────────────────────────────

/**
 * Transform a Zod-validated LLM-emit spec into the canonical form
 * persisted in `workflow.spec`. Throws `WorkflowError` on the first
 * unresolvable node — spec save is all-or-nothing.
 */
export function canonicalize(
  spec: LLMWorkflowSpec,
  deps: CanonicalizeDeps,
): CanonicalWorkflowSpec {
  const nodes = spec.nodes.map((n) => canonicalizeNode(n, deps));
  return {
    ...spec,
    nodes,
    refReconAlgorithm: REF_RECON_ALGORITHM,
  };
}
