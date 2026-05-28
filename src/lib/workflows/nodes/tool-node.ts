/**
 * Tool-node executor — pure data in / data out.
 *
 * The retry loop + event emission live in `with-retries.ts`; this
 * file is the per-attempt body. Per the §7.2 design:
 *
 *   1. Resolve `@path` refs in `node.input`
 *   2. Look up the tool handle (DI) — `null` ⇒
 *      `WorkflowError(TOOL_NOT_FOUND)`
 *   3. `tool.execute({input, abortSignal, context})`
 *   4. Coerce result to `Record<string, unknown>` — non-object
 *     shape ⇒ defensive `TOOL_EXECUTION_FAILED`
 *
 * Failures throw — the surrounding `withRetries` retries up to
 * `node.retries.attempts` times before giving up.
 *
 * Server-vs-MCP distinction lives in the registry, not here (D27).
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
 * Execute one tool node. Returns the node's `outputs` bag on
 * success; throws `WorkflowError` on the final failure after all
 * retries are exhausted.
 */
export async function executeToolNode(
  node: CanonicalToolNode,
  state: ExecutionState,
  deps: ToolNodeDeps,
): Promise<Record<string, unknown>> {
  return withRetries({
    node,
    nodeName: node.tool,
    state,
    deps,
    attemptFn: async () => {
      // Resolve refs in input. resolveRefs throws REF_UNRESOLVED on
      // its own — let the WorkflowError bubble up unchanged (the
      // wrapper's wrapError passes WorkflowError instances through).
      const resolvedInput = resolveRefs(node.input, state) as Record<
        string,
        unknown
      >;

      // Input validation — runs AFTER ref resolution so refs
      // can carry typed values into the schema check. Save-time
      // validate.ts already verified required-key presence
      // (cheap structural check); this catches the full JSON
      // Schema (types, formats, etc.).
      if (node.input_schema !== undefined) {
        const result = validateAgainstSchema(node.input_schema, resolvedInput);
        if (!result.ok) {
          throw new WorkflowError({
            errorCode: "TOOL_INPUT_SCHEMA_MISMATCH",
            message: `Node ${node.id}: tool '${node.tool}' input failed schema — ${formatValidationErrors(result.errors)}`,
            nodeId: node.id,
            nodeName: node.tool,
          });
        }
      }

      // Save-time validate.ts already confirmed the tool existed;
      // this guard catches the case where the registry has changed
      // between save and run (e.g. an MCP server disconnected).
      const tool = deps.getTool(node.tool);
      if (tool === null) {
        throw new WorkflowError({
          errorCode: "TOOL_NOT_FOUND",
          message: `Tool '${node.tool}' is not registered.`,
          nodeId: node.id,
          nodeName: node.tool,
        });
      }

      // The tool implementation is responsible for honouring
      // abortSignal at its internal IO checkpoints.
      const rawResult = await tool.execute({
        input: resolvedInput,
        abortSignal: state.abortSignal,
        context: state.context,
      });

      // Coerce to object — node outputs are `Record<string, unknown>`
      // so downstream `@nodes.<id>.<field>` refs have something to
      // walk into. Defensive only — a well-behaved tool always
      // returns an object matching its declared `output_schema`.
      const outputs = coerceToOutputs(rawResult, node);

      // Output validation — surface tool-side bugs (returning
      // wrong shape) as TOOL_EXECUTION_FAILED (per §7.2 — output
      // mismatch is the tool's contract violation, not a separate
      // error class for tool nodes).
      if (node.output_schema !== undefined) {
        const result = validateAgainstSchema(node.output_schema, outputs);
        if (!result.ok) {
          throw new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: `Node ${node.id}: tool '${node.tool}' output failed schema — ${formatValidationErrors(result.errors)}`,
            nodeId: node.id,
            nodeName: node.tool,
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
        nodeName: node.tool,
        cause: err,
      });
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────

function coerceToOutputs(
  result: unknown,
  node: CanonicalToolNode,
): Record<string, unknown> {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    throw new WorkflowError({
      errorCode: "TOOL_EXECUTION_FAILED",
      message: `Tool '${node.tool}' returned a non-object result (got ${describeShape(result)}); expected an object matching its output_schema.`,
      nodeId: node.id,
      nodeName: node.tool,
    });
  }
  return result as Record<string, unknown>;
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
