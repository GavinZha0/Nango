/**
 * Agent-node executor — pure data in / data out.
 *
 * Retry loop + event emission live in `with-retries.ts`. Per-attempt
 * body:
 *   1. Resolve `@path` refs in `node.inputs.task` and
 *      `node.inputs.context` (full-field refs only — string
 *      interpolation is not v1).
 *   2. Call `deps.runAgent({ agentId: node.inputs.agent_id, ... })`
 *      — the DI bridge that the runner-side dispatch shim wires to
 *      `runner.start({entityKind: 'agent'})`.
 *   3. Return `result.output` shaped as `{ result: string }`
 *      (canonical-fixed agent output schema from NODE_TYPE_REGISTRY).
 *
 * The engine signals intent via `excludeFrontendTools: true`; the
 * runner applies the actual filter before invoking the agent.
 */

import { WorkflowError } from "../error";
import type { CanonicalAgentNode } from "../spec/schema";
import { resolveRefs, type ExecutionState } from "../engine/execution-context";
import type { WorkflowEngineDependencies } from "../engine";
import {
  formatValidationErrors,
  validateAgainstSchema,
} from "./schema-validator";
import { withRetries } from "./with-retries";
import { getNodeTypeDescriptor, getOutputSchema } from "./registry";

export type AgentNodeDeps = Pick<
  WorkflowEngineDependencies,
  "runAgent" | "emitEvent"
>;

/**
 * The agent output contract is canonical-fixed: always { result: string }.
 * Read from the type registry so there is a single source of truth.
 */
const AGENT_OUTPUT_SCHEMA: Record<string, unknown> = (() => {
  const d = getNodeTypeDescriptor("agent", "1");
  const s = d !== undefined ? getOutputSchema(d) : undefined;
  // Fallback: inline definition (should never reach in a healthy build).
  return s ?? {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    additionalProperties: false,
  };
})();

/**
 * Execute one agent node. Returns the agent's structured output on
 * success; throws `WorkflowError` on the final failure after all
 * retries are exhausted.
 */
export async function executeAgentNode(
  node: CanonicalAgentNode,
  state: ExecutionState,
  deps: AgentNodeDeps,
): Promise<Record<string, unknown>> {
  const displayName = node.inputs.name;
  return withRetries({
    node,
    nodeName: displayName,
    state,
    deps,
    attemptFn: async () => {
      const task = resolveRefs(node.inputs.task, state);
      const resolvedInput: Record<string, unknown> = { task };
      if (node.inputs.context !== undefined) {
        resolvedInput.context = resolveRefs(node.inputs.context, state);
      }
      const result = await deps.runAgent({
        agentId: node.inputs.agent_id,
        input: resolvedInput,
        outputSchema: AGENT_OUTPUT_SCHEMA,
        abortSignal: state.abortSignal,
        parentRunId: state.runId,
        excludeFrontendTools: true,
      });

      // Defensive runtime validation — the runner is expected to
      // already shape the agent's reply; this surfaces drift as
      // OUTPUT_SCHEMA_MISMATCH (distinct from TOOL_EXECUTION_FAILED
      // because agents are non-deterministic).
      const validation = validateAgainstSchema(AGENT_OUTPUT_SCHEMA, result.output);
      if (!validation.ok) {
        throw new WorkflowError({
          errorCode: "OUTPUT_SCHEMA_MISMATCH",
          message: `Node ${node.id}: agent '${displayName}' output failed schema — ${formatValidationErrors(validation.errors)}`,
          nodeId: node.id,
          nodeName: displayName,
        });
      }

      return result.output;
    },
    wrapError: (err) => {
      if (err instanceof WorkflowError) return err;
      return new WorkflowError({
        errorCode: "AGENT_EXECUTION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        nodeId: node.id,
        nodeName: displayName,
        cause: err,
      });
    },
  });
}
