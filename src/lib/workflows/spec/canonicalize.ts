/**
 * LLM-emit spec → Canonical stored spec.
 *
 * Per-node enrichment:
 *   - Tool nodes: hydrate `input_schema` / `output_schema` /
 *     `outputs[]` from the tool registry (per-instance snapshot,
 *     protects against tool contract changes between save and refresh).
 *   - Agent nodes: resolve `<source> / <name>` display strings to
 *     UUIDs via EntityCatalog.
 *   - Code / SQL / Chart nodes: stamp `schema_version` and resolve
 *     UUID fields. Input/output schemas and output field lists are
 *     type-level data stored in `../nodes/registry.ts`, not in each
 *     node instance.
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
  type CanonicalChartNode,
  type CanonicalCodeNode,
  type CanonicalNode,
  type CanonicalSqlNode,
  type CanonicalToolNode,
  type CanonicalWorkflowSpec,
  type LLMAgentNode,
  type LLMChartNode,
  type LLMCodeNode,
  type LLMNode,
  type LLMSqlNode,
  type LLMToolNode,
  type LLMWorkflowSpec,
  type NodeType,
} from "./schema";

// ─── Per-node schema version registry ──────────────────────────────────

/**
 * Current `schema_version` for each node type. Stamped onto every
 * canonical node by the per-type canonicalizers below. Bump a single
 * entry when introducing a breaking change to that node's schema; the
 * old `<type>:<oldVersion>` executor must stay registered in the
 * engine so persisted workflows continue to run.
 *
 * Definition lives in code (not the database) because the version
 * is bound to the Zod schema + executor pair that ships together —
 * see docs/workflow-spec.md.
 */
export const NODE_SCHEMA_VERSIONS = {
  tool: "1",
  agent: "1",
  code: "1",
  sql: "1",
  chart: "1",
} as const satisfies Record<NodeType, string>;

/**
 * All `"<type>:<version>"` executor keys this build supports.
 * Always includes every current version from `NODE_SCHEMA_VERSIONS`.
 * When a node type gets a breaking change (version bump from "1" → "2"):
 *   1. Update `NODE_SCHEMA_VERSIONS.<type>` to "2".
 *   2. Add `"<type>:1"` to the legacy list below so persisted v1
 *      specs keep running.
 *   3. Register `"<type>:2"` in `engine/in-process.ts`
 *      `NODE_EXECUTOR_TABLE` and keep the `"<type>:1"` entry.
 *
 * `validate.ts` imports this set to reject specs whose nodes reference
 * an unsupported version at save time rather than failing at refresh.
 */
export const SUPPORTED_EXECUTOR_KEYS: ReadonlySet<string> = new Set<string>([
  // Current versions — always included.
  ...Object.entries(NODE_SCHEMA_VERSIONS).map(([t, v]) => `${t}:${v}`),
  // Legacy versions kept alive for persisted workflows:
  // (none yet — add here when the first breaking schema change lands)
]);

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

/**
 * Lookups canonicalize delegates to its caller. All methods are
 * async because the underlying operations are I/O (DB queries,
 * external HTTP calls to agent platforms, tool-catalog builds).
 * canonicalize awaits each per-node resolution on demand — no
 * pre-hydration step required.
 */
export interface CanonicalizeDeps {
  /** Returns null if the tool name is unknown to the registry. */
  getToolMetadata(toolName: string): Promise<ToolMetadata | null>;
  /**
   * Resolves an `<sourceLabel> / <agentName>` display string to its
   * UUID. Returns null if the agent no longer exists in EntityCatalog
   * or has been disabled.
   */
  resolveAgentId(displayString: string): Promise<string | null>;
  /**
   * Resolves a `data_source.name` slug to its UUID. Returns null if
   * no data source with that name exists or it is disabled.
   */
  resolveDataSourceId(name: string): Promise<string | null>;
}

// ─── Per-node canonicalization ─────────────────────────────────────────

/**
 * Derive a tool node's `outputs[]` list from its tool-registry
 * `output_schema`. Used only for `tool` nodes — all other node types
 * get their output field lists from `../nodes/registry.ts` at
 * validate / execute time.
 *
 * Returns `undefined` when neither source has usable data.
 */
function deriveToolOutputs(
  meta: ToolMetadata,
): string[] | undefined {
  if (meta.outputs !== undefined && meta.outputs.length > 0) {
    return [...meta.outputs];
  }
  const schema = meta.output_schema;
  if (schema === undefined) return undefined;
  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const fields = required.filter((s): s is string => typeof s === "string");
    if (fields.length > 0) return fields;
  }
  const properties = (schema as { properties?: unknown }).properties;
  if (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    const keys = Object.keys(properties as Record<string, unknown>);
    if (keys.length > 0) return keys;
  }
  return undefined;
}

async function canonicalizeToolNode(
  n: LLMToolNode,
  deps: CanonicalizeDeps,
): Promise<CanonicalToolNode> {
  const toolName = n.inputs.name;
  const meta = await deps.getToolMetadata(toolName);
  if (meta === null) {
    throw new WorkflowError({
      errorCode: "TOOL_NOT_FOUND",
      message: `Node ${n.id}: tool '${toolName}' is not registered.`,
      nodeId: n.id,
      nodeName: toolName,
    });
  }
  const canonical: CanonicalToolNode = {
    ...n,
    schema_version: NODE_SCHEMA_VERSIONS.tool,
  };
  // Build input_schema describing the wrapper shape:
  //   { name: const, arguments: <registry-provided args schema> }
  canonical.input_schema = buildToolInputSchema(toolName, meta.input_schema);
  if (meta.output_schema !== undefined) canonical.output_schema = meta.output_schema;
  const outputs = deriveToolOutputs(meta);
  if (outputs !== undefined) canonical.outputs = outputs;
  return canonical;
}

/**
 * Build the canonical `input_schema` for a tool node from the
 * tool name (const-pinned) and the registry-provided args schema.
 */
function buildToolInputSchema(
  toolName: string,
  argsSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: { const: toolName },
      arguments: argsSchema ?? {
        type: "object",
        additionalProperties: true,
      },
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  };
}

async function canonicalizeAgentNode(
  n: LLMAgentNode,
  deps: CanonicalizeDeps,
): Promise<CanonicalAgentNode> {
  const agentDisplayName = n.inputs.name;
  const agentId = await deps.resolveAgentId(agentDisplayName);
  if (agentId === null) {
    throw new WorkflowError({
      errorCode: "AGENT_NOT_FOUND",
      message: `Node ${n.id}: agent '${agentDisplayName}' could not be resolved to a known catalog entry.`,
      nodeId: n.id,
      nodeName: agentDisplayName,
    });
  }
  return {
    ...n,
    schema_version: NODE_SCHEMA_VERSIONS.agent,
    inputs: {
      ...n.inputs,
      agent_id: agentId,
    },
    // input_schema / output_schema / outputs[] no longer stamped per-instance.
    // They are type-level data served from NODE_TYPE_REGISTRY["agent:1"].
  };
}

/**
 * Canonicalize a code node. Only stamps `schema_version`.
 * Output fields are served from the type registry at validate / execute
 * time; if a custom `output_schema` is declared by the LLM it is
 * preserved as an instance field and takes precedence over the
 * registry default during ref validation.
 */
function canonicalizeCodeNode(n: LLMCodeNode): CanonicalCodeNode {
  return {
    ...n,
    schema_version: NODE_SCHEMA_VERSIONS.code,
  };
}

/**
 * Canonicalize a SQL node. Stamps `schema_version` and resolves
 * `data_source_name` → `data_source_id` (UUID).
 */
async function canonicalizeSqlNode(
  n: LLMSqlNode,
  deps: CanonicalizeDeps,
): Promise<CanonicalSqlNode> {
  const dataSourceName = n.inputs.data_source_name;
  const dataSourceId = await deps.resolveDataSourceId(dataSourceName);
  if (dataSourceId === null) {
    throw new WorkflowError({
      errorCode: "DATA_SOURCE_NOT_FOUND",
      message:
        `Node ${n.id}: data source '${dataSourceName}' could not be ` +
        "resolved to a known catalog entry. Check the slug or enable " +
        "the data source.",
      nodeId: n.id,
      nodeName: `sql:${dataSourceName}`,
    });
  }
  return {
    ...n,
    schema_version: NODE_SCHEMA_VERSIONS.sql,
    inputs: {
      ...n.inputs,
      data_source_id: dataSourceId,
    },
    // outputs[] no longer stamped per-instance.
    // Served from NODE_TYPE_REGISTRY["sql:1"] at validate / execute time.
  };
}

/**
 * Canonicalize a chart node. Only stamps `schema_version`.
 * input_schema / output_schema / outputs[] served from
 * NODE_TYPE_REGISTRY["chart:1"].
 */
function canonicalizeChartNode(n: LLMChartNode): CanonicalChartNode {
  return {
    ...n,
    schema_version: NODE_SCHEMA_VERSIONS.chart,
  };
}

async function canonicalizeNode(
  n: LLMNode,
  deps: CanonicalizeDeps,
): Promise<CanonicalNode> {
  switch (n.type) {
    case "tool":
      return canonicalizeToolNode(n, deps);
    case "agent":
      return canonicalizeAgentNode(n, deps);
    case "code":
      return canonicalizeCodeNode(n);
    case "sql":
      return canonicalizeSqlNode(n, deps);
    case "chart":
      return canonicalizeChartNode(n);
  }
}

// ─── Public entrypoint ─────────────────────────────────────────────────

/**
 * Transform a Zod-validated LLM-emit spec into the canonical form
 * persisted in `workflow.spec`. Async because per-node resolution
 * (tool metadata, agent UUID, data-source UUID) requires I/O.
 * Throws `WorkflowError` on the first unresolvable node — spec save
 * is all-or-nothing.
 */
export async function canonicalize(
  spec: LLMWorkflowSpec,
  deps: CanonicalizeDeps,
): Promise<CanonicalWorkflowSpec> {
  const nodes: CanonicalNode[] = [];
  for (const n of spec.nodes) {
    nodes.push(await canonicalizeNode(n, deps));
  }
  return {
    ...spec,
    nodes,
  };
}
