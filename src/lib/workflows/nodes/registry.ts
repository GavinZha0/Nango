/**
 * Workflow Node Type Registry — single source of truth for
 * type-specific JSON Schema definitions.
 *
 * Responsibility
 * --------------
 * This file is the JSON Schema world: machine-readable node type
 * contracts used by LLM prompts, UI form generation, and runtime
 * validation. It answers the question "what does this node type
 * accept and produce?" for any non-TypeScript consumer.
 *
 * Each node type is described by ONE `schema` object:
 *
 *   schema.properties.inputs  — authoring-time fields (stored in
 *                               workflow.spec). Derived from the
 *                               canonical Zod schemas in schema.ts
 *                               via z.toJSONSchema() so field
 *                               descriptions are defined once.
 *                               Fields with `x-canonical-only: true`
 *                               are stamped by canonicalize and are
 *                               omitted from the LLM-facing view
 *                               (see getLLMInputSchema()).
 *
 *   schema.properties.outputs — runtime output envelope (NOT stored
 *                               in spec; available as @nodes.X.<field>
 *                               refs). Defined manually here because
 *                               outputs are execution-time data, not
 *                               part of the Zod spec schemas.
 *
 * Universal fields (id, type, schema_version, description, depends_on,
 * retries, timeout_seconds) are common to all node types and are
 * documented in BASE_NODE_SCHEMA rather than duplicated per type.
 *
 * `tool` nodes are intentionally absent: each tool has a different,
 * per-instance schema (snapshotted from the tool registry at save
 * time). They cannot be described by a single static registry entry.
 *
 * See docs/workflow-architecture.md (Key Design Principles).
 */

import { z } from "zod";

import type { NodeType } from "../spec/schema";
import {
  CanonicalAgentInputsSchema,
  CanonicalCodeInputsSchema,
  CanonicalSqlInputsSchema,
  CanonicalChartInputsSchema,
} from "../spec/schema";

// ─── Types ─────────────────────────────────────────────────────────────

/** Plain JSON Schema object. */
export type JSONSchemaObject = Record<string, unknown>;

/**
 * Descriptor for one (type, version) of a fixed-schema workflow node.
 *
 * `schema.properties.inputs`  — authoring-time configuration (stored in spec).
 * `schema.properties.outputs` — runtime output envelope (NOT in spec).
 *
 * Consumers call the accessor functions below to extract the part they need.
 */
export interface NodeTypeDescriptor {
  readonly type: NodeType;
  readonly version: string;
  readonly schema: JSONSchemaObject;
}

// ─── Universal base schema ─────────────────────────────────────────────

/**
 * JSON Schema describing the fields shared by EVERY canonical node.
 * Compose with a type-specific descriptor schema to obtain the
 * complete node shape.
 */
export const BASE_NODE_SCHEMA: JSONSchemaObject = {
  type: "object",
  properties: {
    id: {
      type: "integer",
      minimum: 0,
      description:
        "Stable numeric node id within the spec. Assigned sequentially from 0 " +
        "at save time. Used in @nodes.<id>.field downstream refs.",
    },
    type: {
      type: "string",
      enum: ["tool", "agent", "code", "sql", "chart"],
      description: "Node type discriminator.",
    },
    schema_version: {
      type: "string",
      description:
        "Per-type schema version stamped by canonicalize. Determines which " +
        "executor branch handles this node. Currently '1' for all types.",
    },
    description: {
      type: "string",
      minLength: 1,
      description:
        "Human-readable description of what this node does. Required. " +
        "Used by modify_workflow to locate the right node by intent.",
    },
    depends_on: {
      type: "array",
      items: { type: "integer" },
      description:
        "Ids of upstream nodes this node depends on. The scheduler holds " +
        "this node until all listed nodes have completed.",
    },
    retries: {
      type: "object",
      properties: {
        attempts:      { type: "integer", minimum: 0 },
        delay_seconds: { type: "integer", minimum: 0 },
        backoff:       { type: "string", enum: ["fixed", "exponential"] },
      },
      required: ["attempts", "delay_seconds"],
      description:
        "Optional retry policy. attempts = max retries after the first failure " +
        "(0 = single try, no retries).",
    },
    timeout_seconds: {
      type: "integer",
      minimum: 1,
      description: "Per-node timeout. Overrides the spec-level execution.timeout_seconds.",
    },
  },
  required: ["id", "type", "schema_version", "description", "depends_on"],
};

// ─── Helper ────────────────────────────────────────────────────────────

/**
 * Convert a Zod schema to a plain JSON Schema object, stripping the
 * `$schema` meta-key that `z.toJSONSchema()` adds at the top level.
 * The resulting object is used as a sub-schema within node schemas
 * where a top-level `$schema` declaration is unnecessary.
 */
function zodToSchema(schema: z.ZodType): JSONSchemaObject {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest as JSONSchemaObject;
}

// ─── Node type schemas ─────────────────────────────────────────────────
//
// Each schema has exactly two sub-properties:
//   inputs  — derived from the canonical Zod schema via zodToSchema()
//   outputs — defined inline (runtime data, not captured by Zod)
//
// Output schemas are inlined rather than extracted into named constants
// because they have no external consumers: all callers go through
// getOutputSchema() / getOutputFields() rather than referencing a
// specific node type's output shape by name.

const SQL_NODE_SCHEMA: JSONSchemaObject = {
  type: "object",
  description:
    "SQL data-extraction node. Runs a DuckDB-dialect query against a data source, " +
    "materializes the result as a Parquet snapshot, and delivers inline row objects " +
    "for downstream chart/code nodes.",
  properties: {
    inputs: {
      ...zodToSchema(CanonicalSqlInputsSchema),
      description: "Authoring-time configuration (stored in workflow.spec).",
    },
    outputs: {
      type: "object",
      description:
        "Runtime outputs (NOT stored in spec; available as @nodes.X.<field> refs). " +
        "The rows column structure varies by SQL query; row_schema documents it at runtime.",
      properties: {
        dataset_name: {
          type: "string",
          description:
            "Parquet dataset slug. Reference in downstream code nodes via " +
            "@nodes.X.dataset_name; engine mounts it at ./data/<name>/.",
        },
        total_rows: {
          type: "integer",
          description:
            "Full result-set row count. Compare with returned_rows to detect truncation.",
        },
        returned_rows: {
          type: "integer",
          description:
            "Rows delivered inline. Equals total_rows in full-inline mode; " +
            "less when the result exceeds the engine row cap.",
        },
        rows: {
          type: "array",
          items: { type: "object" },
          description:
            "Inline row objects. Column names vary by SQL query. " +
            "Reference via @nodes.X.rows in downstream chart nodes.",
        },
        row_schema: {
          type: "object",
          description:
            "Per-column type metadata inferred from the query. " +
            "Populated even for zero-row results.",
        },
      },
      required: ["dataset_name", "total_rows", "returned_rows", "rows", "row_schema"],
      additionalProperties: false,
    },
  },
  required: ["inputs"],
};

const AGENT_NODE_SCHEMA: JSONSchemaObject = {
  type: "object",
  description:
    "Agent delegation node. Invokes a built-in agent with a task prompt and returns " +
    "its text reply as { result: string }. Only agents with role = null (regular agents) " +
    "are eligible; system-role agents are blocked at save time.",
  properties: {
    inputs: {
      ...zodToSchema(CanonicalAgentInputsSchema),
      description: "Authoring-time configuration (stored in workflow.spec).",
    },
    outputs: {
      type: "object",
      description:
        "Runtime outputs (NOT stored in spec; available as @nodes.X.<field> refs). " +
        "Fixed contract: always { result: string }.",
      properties: {
        result: {
          type: "string",
          description: "The agent's text reply. Reference downstream via @nodes.X.result.",
        },
      },
      required: ["result"],
      additionalProperties: false,
    },
  },
  required: ["inputs"],
};

const CODE_NODE_SCHEMA: JSONSchemaObject = {
  type: "object",
  description:
    "Sandboxed code execution node. Runs Python or JavaScript in an isolated process " +
    "with optional dataset mounts and runtime parameters.",
  properties: {
    inputs: {
      ...zodToSchema(CanonicalCodeInputsSchema),
      description: "Authoring-time configuration (stored in workflow.spec).",
    },
    outputs: {
      type: "object",
      description:
        "Fixed CodeOutputEnvelope returned by the code executor. " +
        "Runtime outputs (NOT stored in spec; available as @nodes.X.<field> refs). " +
        "When ok=false the code failed; downstream nodes should check before using rows.",
      properties: {
        ok:          { type: "boolean",  description: "true when exit_code === 0." },
        duration_ms: { type: "integer",  description: "Sandbox execution wall-clock time in milliseconds." },
        rows: {
          type: "array",
          items: { type: "object" },
          description:
            "Structured output data — always an array of plain objects, or null. " +
            "For chart nodes: inputs.dataset = \"@nodes.X.rows\"",
        },
        row_count:  { type: "integer",  description: "rows.length, or null when rows is null." },
        row_schema: { type: "object",   description: "Per-column type metadata inferred from rows[0]." },
        message:    { type: "string",   description: "Human-readable text from output_info, or raw stdout fallback." },
        files:      { type: "array", items: { type: "string" }, description: "Generated file names (future)." },
        error:      { type: "string",   description: "Error message when ok=false (from stderr). Null when ok=true." },
      },
      required: ["ok", "duration_ms"],
      additionalProperties: false,
    },
  },
  required: ["inputs"],
};

const CHART_NODE_SCHEMA: JSONSchemaObject = {
  type: "object",
  description:
    "Declarative chart node. Stores an ECharts option TEMPLATE with a @path ref to " +
    "upstream row data. The engine merges them at execute time; the browser renders the result.",
  properties: {
    inputs: {
      ...zodToSchema(CanonicalChartInputsSchema),
      description: "Authoring-time configuration (stored in workflow.spec).",
    },
    outputs: {
      type: "object",
      description:
        "Runtime outputs (NOT stored in spec; available as @nodes.X.<field> refs). " +
        "Fixed contract: always { option: object }.",
      properties: {
        option: {
          type: "object",
          description:
            "Complete merged ECharts option JSON ready for <EChartsRenderer />. " +
            "config.dataset[i].source has been filled from inputs.dataset.",
        },
      },
      required: ["option"],
      additionalProperties: false,
    },
  },
  required: ["inputs"],
};

// ─── Registry ──────────────────────────────────────────────────────────

/**
 * Central registry of all fixed-schema node type descriptors.
 *
 * Key: `"<type>:<version>"` — matches the executor table key in
 * `engine/in-process.ts`. Both tables MUST stay in sync: adding a
 * node type or bumping a schema version requires a new entry in BOTH.
 *
 * `tool` nodes are intentionally absent — per-tool dynamic schemas
 * are snapshotted per instance by canonicalize at save time.
 */
export const NODE_TYPE_REGISTRY: Record<string, NodeTypeDescriptor> = {
  "sql:1":   { type: "sql",   version: "1", schema: SQL_NODE_SCHEMA },
  "agent:1": { type: "agent", version: "1", schema: AGENT_NODE_SCHEMA },
  "code:1":  { type: "code",  version: "1", schema: CODE_NODE_SCHEMA },
  "chart:1": { type: "chart", version: "1", schema: CHART_NODE_SCHEMA },
};

// ─── Accessor helpers ──────────────────────────────────────────────────

/**
 * Look up the NodeTypeDescriptor for a (type, version) pair.
 * Returns undefined for unknown keys — treat as a validation error.
 */
export function getNodeTypeDescriptor(
  type: string,
  version: string,
): NodeTypeDescriptor | undefined {
  return NODE_TYPE_REGISTRY[`${type}:${version}`];
}

/**
 * Extract the `inputs` sub-schema (canonical form, including
 * x-canonical-only fields). Used by validate.ts for required-field
 * checks and by canonicalize for stamping.
 */
export function getInputSchema(
  descriptor: NodeTypeDescriptor,
): JSONSchemaObject | undefined {
  const props = (descriptor.schema as { properties?: Record<string, JSONSchemaObject> }).properties;
  return props?.inputs;
}

/**
 * Extract the `outputs` sub-schema (runtime output envelope).
 * Used by validate.ts for @nodes.X.field ref checks.
 */
export function getOutputSchema(
  descriptor: NodeTypeDescriptor,
): JSONSchemaObject | undefined {
  const props = (descriptor.schema as { properties?: Record<string, JSONSchemaObject> }).properties;
  return props?.outputs;
}

/**
 * Return the output field names available as @nodes.X.<field> refs.
 * Derived from the outputs sub-schema's `required` array (or
 * `properties` keys as fallback).
 *
 * P1: validate.ts will call this instead of reading node.outputs[]
 * from the canonical spec instance.
 */
export function getOutputFields(
  descriptor: NodeTypeDescriptor,
): ReadonlyArray<string> {
  const schema = getOutputSchema(descriptor);
  if (schema === undefined) return [];
  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    return required.filter((f): f is string => typeof f === "string");
  }
  const properties = (schema as { properties?: unknown }).properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    return Object.keys(properties as Record<string, unknown>);
  }
  return [];
}

/**
 * Return the LLM-facing input schema: the canonical inputs schema
 * with `x-canonical-only` fields stripped.
 *
 * Use this when:
 *   - Generating the node type catalog for the workflow-builder agent
 *     system prompt
 *   - Rendering an authoring form in the UI
 *
 * The canonical form (with all fields) is what validate.ts and
 * canonicalize use; this filtered form is what LLMs and human editors
 * should see.
 */
export function getLLMInputSchema(
  descriptor: NodeTypeDescriptor,
): JSONSchemaObject | undefined {
  const inputSchema = getInputSchema(descriptor);
  if (inputSchema === undefined) return undefined;

  const properties = (inputSchema as { properties?: Record<string, JSONSchemaObject> }).properties;
  if (!properties) return inputSchema;

  const required = ((inputSchema as { required?: string[] }).required ?? []);
  const filteredProps: Record<string, JSONSchemaObject> = {};
  const filteredRequired: string[] = [];

  for (const [key, fieldSchema] of Object.entries(properties)) {
    if ((fieldSchema as { "x-canonical-only"?: boolean })["x-canonical-only"] === true) continue;
    filteredProps[key] = fieldSchema;
    if (required.includes(key)) filteredRequired.push(key);
  }

  return {
    ...inputSchema,
    properties: filteredProps,
    ...(filteredRequired.length > 0 ? { required: filteredRequired } : { required: [] }),
  };
}

/**
 * Verify that NODE_TYPE_REGISTRY covers the same (type, version) keys
 * as the executor table, excluding tool:* entries (which are dynamic).
 * Returns the set of executor keys absent from this registry — should
 * be empty in a healthy build.
 */
export function missingRegistryKeys(
  executorKeys: ReadonlySet<string>,
): Set<string> {
  const missing = new Set<string>();
  for (const key of executorKeys) {
    if (key.startsWith("tool:")) continue;
    if (!NODE_TYPE_REGISTRY[key]) missing.add(key);
  }
  return missing;
}
