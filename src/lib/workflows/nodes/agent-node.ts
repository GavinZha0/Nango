/**
 * Agent-node executor — pure data in / data out.
 *
 * Retry loop + event emission live in `with-retries.ts`. Per-
 * attempt body:
 *
 *   1. Resolve `@path` refs in `node.input`
 *   2. Call `deps.runAgent({...})` — DI bridge that the runner-
 *      side dispatch shim wires to `runner.start({kind: 'agent'})`
 *      with `parent_run_id` set for run-tree linkage (D17). The
 *      engine never imports `runner/` directly.
 *   3. Return `result.output` (already structured per
 *      `outputSchema`).
 *
 * D16 (frontend_tool filter): the engine signals intent via
 * `excludeFrontendTools: true`; the runner applies the actual
 * filter before invoking the agent.
 *
 * D30 (default agent output_schema = `{text: string}`): the
 * runner wraps the agent's natural-language reply into
 * `{ text: <reply> }`; the engine just plumbs the schema through.
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

export type AgentNodeDeps = Pick<
  WorkflowEngineDependencies,
  "runAgent" | "emitEvent"
>;

/**
 * Execute one agent node. Returns the agent's structured output
 * on success; throws `WorkflowError` on the final failure after
 * all retries are exhausted.
 */
export async function executeAgentNode(
  node: CanonicalAgentNode,
  state: ExecutionState,
  deps: AgentNodeDeps,
): Promise<Record<string, unknown>> {
  return withRetries({
    node,
    nodeName: node.agent,
    state,
    deps,
    attemptFn: async () => {
      const resolvedInput = resolveRefs(node.input, state) as Record<
        string,
        unknown
      >;
      const result = await deps.runAgent({
        agentId: node.agentId,
        input: resolvedInput,
        outputSchema: node.output_schema,
        abortSignal: state.abortSignal,
        parentRunId: state.runId,
        excludeFrontendTools: true,
      });

      // Output validation — D30's default `{text: string}` schema
      // (or whatever the spec declared). The runner is expected to
      // already shape the agent's reply, but defensive runtime
      // validation surfaces drift between the agent and the spec
      // as OUTPUT_SCHEMA_MISMATCH (vs TOOL_EXECUTION_FAILED for
      // tool nodes — agents are non-deterministic so we use a
      // distinct code).
      const validation = validateAgainstSchema(
        node.output_schema,
        result.output,
      );
      if (!validation.ok) {
        throw new WorkflowError({
          errorCode: "OUTPUT_SCHEMA_MISMATCH",
          message: `Node ${node.id}: agent '${node.agent}' output failed schema — ${formatValidationErrors(validation.errors)}`,
          nodeId: node.id,
          nodeName: node.agent,
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
        nodeName: node.agent,
        cause: err,
      });
    },
  });
}
