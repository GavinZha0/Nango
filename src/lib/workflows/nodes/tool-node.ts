/**
 * Tool-node executor — pure data in / data out.
 *
 * Retry loop + event emission live in `with-retries.ts`; this file is
 * the per-attempt body:
 *   1. Resolve `@path` refs in `node.inputs.arguments`.
 *      (`inputs.name` is a const-pinned tool identifier — no refs.)
 *   2. Validate resolved args against the args sub-schema lifted
 *      from `node.input_schema.properties.arguments` (ajv).
 *   3. Look up the tool handle (DI) — `null` → `TOOL_NOT_FOUND`.
 *   4. `tool.execute({input: resolvedArgs, abortSignal, context})`.
 *   5. Coerce result to `Record<string, unknown>`; validate against
 *      `output_schema` (ajv).
 *
 * Server-vs-MCP distinction lives in the registry, not here.
 */

import { WorkflowError } from "../error";
import type { CanonicalToolNode } from "../spec/schema";
import { resolveRefs, type ExecutionState } from "../engine/execution-context";
import type { WorkflowEngineDependencies } from "../engine";
import {
  formatValidationErrors,
  validateAgainstSchema,
} from "./schema-validator";
import { withRetries } from "./with-retries";

export type ToolNodeDeps = Pick<
  WorkflowEngineDependencies,
  "getTool" | "emitEvent"
>;

/**
 * Execute one tool node. Returns the node's `outputs` bag on success;
 * throws `WorkflowError` on the final failure after all retries are
 * exhausted.
 */
export async function executeToolNode(
  node: CanonicalToolNode,
  state: ExecutionState,
  deps: ToolNodeDeps,
): Promise<Record<string, unknown>> {
  const toolName = node.inputs.name;
  return withRetries({
    node,
    nodeName: toolName,
    state,
    deps,
    attemptFn: async () => {
      // resolveRefs throws REF_UNRESOLVED on its own — let the
      // WorkflowError bubble up unchanged.
      const resolvedArgs = resolveRefs(node.inputs.arguments, state) as Record<
        string,
        unknown
      >;

      // Input validation runs AFTER ref resolution so refs can carry
      // typed values into the schema check. Save-time validate.ts
      // already verified required-key presence; this catches the
      // full JSON Schema (types, formats, etc.).
      const argsSchema = extractArgsSchema(node.input_schema);
      if (argsSchema !== undefined) {
        const result = validateAgainstSchema(argsSchema, resolvedArgs);
        if (!result.ok) {
          throw new WorkflowError({
            errorCode: "TOOL_INPUT_SCHEMA_MISMATCH",
            message: `Node ${node.id}: tool '${toolName}' input failed schema — ${formatValidationErrors(result.errors)}`,
            nodeId: node.id,
            nodeName: toolName,
          });
        }
      }

      // Save-time validate.ts already confirmed the tool existed;
      // this guard catches the case where the registry has changed
      // between save and run (e.g. MCP server disconnected).
      const tool = deps.getTool(toolName);
      if (tool === null) {
        throw new WorkflowError({
          errorCode: "TOOL_NOT_FOUND",
          message: `Tool '${toolName}' is not registered.`,
          nodeId: node.id,
          nodeName: toolName,
        });
      }

      // The tool implementation is responsible for honouring
      // abortSignal at its internal IO checkpoints.
      const rawResult = await tool.execute({
        input: resolvedArgs,
        abortSignal: state.abortSignal,
        context: state.context,
      });

      const outputs = coerceToOutputs(rawResult, node, toolName);

      // Output validation — surface tool-side bugs (wrong shape) as
      // TOOL_EXECUTION_FAILED.
      if (node.output_schema !== undefined) {
        const result = validateAgainstSchema(node.output_schema, outputs);
        if (!result.ok) {
          throw new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: `Node ${node.id}: tool '${toolName}' output failed schema — ${formatValidationErrors(result.errors)}`,
            nodeId: node.id,
            nodeName: toolName,
          });
        }
      }

      return outputs;
    },
    wrapError: (err) => {
      if (err instanceof WorkflowError) return err;
      return new WorkflowError({
        errorCode: "TOOL_EXECUTION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        nodeId: node.id,
        nodeName: toolName,
        cause: err,
      });
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Pull the `arguments` sub-schema out of the wrapper `input_schema`
 * canonicalize stamped on the tool node. Returns `undefined` when
 * the wrapper is malformed or the args slot is missing — caller
 * skips validation in that case.
 */
function extractArgsSchema(
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (inputSchema === undefined) return undefined;
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return undefined;
  }
  const args = (properties as { arguments?: unknown }).arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  return args as Record<string, unknown>;
}

function coerceToOutputs(
  result: unknown,
  node: CanonicalToolNode,
  toolName: string,
): Record<string, unknown> {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    throw new WorkflowError({
      errorCode: "TOOL_EXECUTION_FAILED",
      message: `Tool '${toolName}' returned a non-object result (got ${describeShape(result)}); expected an object matching its output_schema.`,
      nodeId: node.id,
      nodeName: toolName,
    });
  }
  return result as Record<string, unknown>;
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
