/**
 * LLM-emit spec → Canonical stored spec.
 *
 * This step performs the *structural* enrichment that
 * `workflow.spec` JSONB stores:
 *
 *   1. Stamp the V1 bucket tag `type: "tool" | "agent"` (D27) so
 *      Zod's discriminated union on the canonical side validates.
 *   2. Resolve agent display strings (`<source> / <name>`, D13)
 *      one-shot via the caller-supplied EntityCatalog adapter
 *      (D27): `agentId` is locked at save time so runtime dispatch
 *      never re-queries the catalog.
 *   3. Hydrate tool nodes with registry-derived schemas
 *      (`input_schema`, `output_schema`, `outputs[]`) so the engine
 *      can validate node inputs and propagate refs without a tool
 *      registry round-trip per node per run.
 *   4. Stamp `refReconAlgorithm: "ref_recon_v1"` (D26) — tracks the
 *      save-time ref reconstruction algorithm version for V2
 *      re-capture compatibility.
 *
 * Out of scope (intentionally):
 *
 *   - DAG validation, cycle detection, ref reachability  → `validate.ts`
 *   - Deterministic hash of the canonical spec            → `hash.ts`
 *   - Filling default `timeoutSeconds` / `retries` /      → engine reads
 *     `max_parallelism` from config keys                     config at
 *                                                            execute time
 *     The latter is deliberate: storing materialised defaults would
 *     freeze workflows against later operator tuning of the
 *     `workflow.execution.*` and `workflow.node.*` config keys.
 *
 * Failure mode: every problem throws a `WorkflowError`. The
 * surrounding save pipeline (`build-from-events.ts`, W2) calls
 * `toResult(we)` at its catch boundary to emit the standard wire
 * envelope back to the LLM caller (`modify_workflow`).
 *
 * See `docs/workflow-architecture.md` §6.1–§6.3 for the canonical
 * spec shape and §7.9 for the error contract.
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
 * Tool-registry view that canonicalize needs. Returned fields are
 * all optional because some tools (notably MCP tools whose server
 * is offline at save time) ship with only partial metadata; the
 * spec is still storable in that case and the engine surfaces a
 * `TOOL_INPUT_SCHEMA_MISMATCH` at execute time if validation later
 * fails.
 */
export interface ToolMetadata {
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  outputs?: readonly string[];
}

/**
 * The two lookups canonicalize delegates to its caller. Wiring up
 * the actual tool registry + EntityCatalog adapters happens in
 * `build-from-events.ts` (W2) — the workflow module itself stays
 * decoupled from those subsystems.
 */
export interface CanonicalizeDeps {
  /** Returns null if the tool name is unknown to the registry. */
  getToolMetadata(toolName: string): ToolMetadata | null;
  /**
   * Resolves an `<sourceLabel> / <agentName>` display string
   * (D13 format) to its UUID. Returns null if the agent no longer
   * exists in EntityCatalog or has been disabled.
   */
  resolveAgentId(displayString: string): string | null;
}

/** D26 — current save-time ref reconstruction algorithm version. */
export const REF_RECON_ALGORITHM = "ref_recon_v1" as const;

// ─── Per-node canonicalization ─────────────────────────────────────────

/**
 * Derive a node's `outputs[]` list from a JSON-Schema-shaped
 * `output_schema`. Two modes:
 *
 *   - `required`-only (tool / agent nodes): `output_schema.required`
 *     is THE authoritative source. Missing / empty → no outputs[]
 *     emitted (canonical JSON stays minimal). Mirrors D19 source 2
 *     semantics.
 *   - `properties` fallback (code nodes via `mode: "code"`): when
 *     `required` is absent or empty, fall back to the keys of
 *     `properties`. Code nodes commonly declare a schema without
 *     `required` because the contract is "stdout prints exactly
 *     these keys", not "these keys are required to be non-null".
 *
 * Returns `undefined` when neither source has usable data —
 * caller (canonicalize fallback / engine default unwrapping) is
 * responsible for filling a default.
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
  // D30 — agent nodes always carry `output_schema` (required by
  // `LLMAgentNodeSchema`). Surface its `required` list as the
  // top-level `outputs[]` for downstream ref-target validation.
  const outputs = deriveOutputsFromSchema(n.output_schema);
  if (outputs !== undefined) canonical.outputs = outputs;
  return canonical;
}

/**
 * Canonicalize a code node (D35).
 *
 *   - When the spec declared `output_schema`, derive `outputs[]`
 *     from `output_schema.properties` (or `required`) so downstream
 *     `@nodes.X.<key>` refs can be ref-validated at save time.
 *   - When `output_schema` is absent, fall back to
 *     `DEFAULT_CODE_NODE_OUTPUTS` (`stdout`, `stderr`, `exitCode`,
 *     `durationMs`) so the engine's default unwrapping path still
 *     exposes typed outputs to downstream refs.
 *
 * No agent / tool catalog lookup — code nodes' identity is
 * self-contained in `language + code`.
 */
function canonicalizeCodeNode(n: LLMCodeNode): CanonicalCodeNode {
  const canonical: CanonicalCodeNode = { ...n };
  const declared = deriveOutputsFromSchema(n.output_schema, "code");
  canonical.outputs =
    declared !== undefined ? declared : [...DEFAULT_CODE_NODE_OUTPUTS];
  return canonical;
}

/**
 * Canonicalize a SQL node (D36).
 *
 * Fixed-shape contract: the engine's executor strips the
 * extract_dataset_by_sql tool result down to `{ name, rowCount }`,
 * so the canonical outputs list is always `DEFAULT_SQL_NODE_OUTPUTS`.
 * No tool-registry / EntityCatalog lookup — SQL node identity is
 * self-contained in `dataSourceName + query` (the latter being the
 * "main body" parallel to code's `code` string).
 *
 * The `dataSourceName` slug is NOT resolved against `data_source`
 * at save time — that lookup is deferred to runtime (in
 * `data-sources/lookup.ts`) so a temporarily-disabled data source
 * doesn't block the save. A missing slug surfaces as a runtime
 * error rather than a save-time canonicalize failure.
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
 * persisted in `workflow.spec`. Throws `WorkflowError` on the
 * first unresolvable node so the save pipeline can fail fast — V1
 * spec save is all-or-nothing.
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
