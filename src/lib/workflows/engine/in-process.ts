/**
 * Default `WorkflowEngine` implementation — drives the DAG in-process
 * via the local scheduler + per-type node executors.
 *
 * Lifecycle:
 *   workflow_started
 *     → createExecutionState → runScheduler (per node:
 *       workflow_node_attempt_started → completed / attempt_failed)
 *     → inspect state.failed → first failure throws + workflow_failed
 *     → abort check → WORKFLOW_TIMEOUT throws + workflow_failed
 *     → resolveWorkflowOutputs (spec.outputs map → resolved values)
 *     → workflow_completed
 *     → return WorkflowResult
 *
 * See docs/workflow.md.
 */

import { WorkflowError } from "../error";
import { parseRef } from "../spec/refs";
import type { CanonicalWorkflowSpec } from "../spec/schema";
import { executeAgentNode } from "../nodes/agent-node";
import { executeCodeNode } from "../nodes/code-node";
import { executeSqlNode } from "../nodes/sql-node";
import { executeToolNode } from "../nodes/tool-node";
import { computeCacheKey, type WorkflowCache } from "./cache";
import {
  createExecutionState,
  resolveRefs,
  type ExecutionState,
} from "./execution-context";
import { runScheduler, type NodeExecutor } from "./scheduler";
import type {
  ExecuteParams,
  WorkflowEngine,
  WorkflowEngineDependencies,
  WorkflowResult,
} from "./index";

// ─── Public engine ─────────────────────────────────────────────────────

/**
 * In-process workflow engine. Stateless singleton — all per-run state
 * lives in `ExecutionState` derived from `ExecuteParams`, never on
 * the engine instance itself.
 */
export const inProcessWorkflowEngine: WorkflowEngine = {
  async execute(
    params: ExecuteParams,
    deps: WorkflowEngineDependencies,
  ): Promise<WorkflowResult> {
    deps.emitEvent({ type: "workflow_started", runId: params.runId });

    const state = createExecutionState(params);
    const baseExecutor = buildNodeExecutor(deps);
    const executor =
      deps.cache === undefined
        ? baseExecutor
        : withCache(baseExecutor, deps.cache, deps);

    await runScheduler({
      state,
      executeNode: executor,
      maxParallelism: params.spec.execution?.max_parallelism,
      onFailure: params.spec.execution?.on_failure,
    });

    // Surface the first failure (lowest id wins for determinism —
    // the run timeline can show all of them via the per-node
    // `workflow_node_attempt_failed` events).
    if (state.failed.size > 0) {
      const firstFailedId = Math.min(...state.failed);
      const firstErr =
        state.nodeErrors.get(firstFailedId) ?? unknownNodeError(firstFailedId);
      emitWorkflowFailed(deps, params.runId, firstErr);
      throw firstErr;
    }

    // Scheduler exited early (abort or starvation) without completing
    // every node → WORKFLOW_TIMEOUT.
    if (state.completed.size !== params.spec.nodes.length) {
      const wf = new WorkflowError({
        errorCode: "WORKFLOW_TIMEOUT",
        message: state.abortSignal.aborted
          ? "Workflow was aborted before all nodes completed."
          : "Workflow scheduler stopped before all nodes completed.",
      });
      emitWorkflowFailed(deps, params.runId, wf);
      throw wf;
    }

    const output = resolveWorkflowOutputs(params.spec, state);

    deps.emitEvent({
      type: "workflow_completed",
      runId: params.runId,
      output,
    });

    return {
      ok: true,
      runId: params.runId,
      output,
      nodeOutputs: state.outputs,
    };
  },
};

// ─── Dispatcher: tool vs agent ─────────────────────────────────────────

function buildNodeExecutor(deps: WorkflowEngineDependencies): NodeExecutor {
  return async (nodeId, state) => {
    const node = state.spec.nodes.find((n) => n.id === nodeId);
    if (node === undefined) {
      // Should be unreachable post-validate; defensive nonetheless.
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `Engine dispatcher: node id ${nodeId} not found in spec.`,
        nodeId,
      });
    }
    if (node.type === "tool") return executeToolNode(node, state, deps);
    if (node.type === "agent") return executeAgentNode(node, state, deps);
    if (node.type === "code") return executeCodeNode(node, state, deps);
    if (node.type === "sql") return executeSqlNode(node, state, deps);
    const _exhaustive: never = node;
    throw new WorkflowError({
      errorCode: "SPEC_SCHEMA_MISMATCH",
      message: `Unknown node type: ${JSON.stringify(_exhaustive)}`,
      nodeId,
    });
  };
}

// ─── Workflow-level outputs ────────────────────────────────────────────

function resolveWorkflowOutputs(
  spec: CanonicalWorkflowSpec,
  state: ExecutionState,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, refStr] of Object.entries(spec.outputs)) {
    // validate.ts already ensured each value is a parseable ref; the
    // parseRef check here is a redundancy belt for stored specs that
    // bypass the save pipeline (e.g. seeded builtins).
    const ref = parseRef(refStr);
    if (ref === null) {
      throw new WorkflowError({
        errorCode: "SPEC_SCHEMA_MISMATCH",
        message: `spec.outputs['${key}'] is not a valid ref string: ${JSON.stringify(refStr)}`,
      });
    }
    try {
      output[key] = resolveRefs(refStr, state);
    } catch (err) {
      // REF_UNRESOLVED for spec.outputs is workflow-scoped (not
      // pinned to any node) — re-throw as OUTPUT_REF_UNRESOLVED so
      // the wire envelope reflects the workflow-level scope.
      if (
        err instanceof WorkflowError &&
        err.errorCode === "REF_UNRESOLVED"
      ) {
        throw new WorkflowError({
          errorCode: "OUTPUT_REF_UNRESOLVED",
          message: `spec.outputs['${key}'] could not be resolved: ${err.message}`,
          cause: err,
        });
      }
      throw err;
    }
  }
  return output;
}

// ─── Failure event helper ──────────────────────────────────────────────

function emitWorkflowFailed(
  deps: WorkflowEngineDependencies,
  runId: string,
  err: WorkflowError,
): void {
  const event: Parameters<typeof deps.emitEvent>[0] = {
    type: "workflow_failed",
    runId,
    errorCode: err.errorCode,
    message: err.message,
  };
  if (err.nodeId !== undefined) event.nodeId = err.nodeId;
  deps.emitEvent(event);
}

function unknownNodeError(nodeId: number): WorkflowError {
  return new WorkflowError({
    errorCode: "UNKNOWN_ERROR",
    message: `Node ${nodeId} was marked failed but no error was recorded.`,
    nodeId,
  });
}

// ─── Cache wrapper ─────────────────────────────────────────────────────

/**
 * Wrap a `NodeExecutor` with per-node cache lookup. On hit, emit a
 * synthetic `workflow_node_completed` event with `cached: true` and
 * `durationMs: 0` and return the cached outputs (skips refs, tool
 * dispatch, schema validation — the same content was already
 * validated on the cached run). On miss, call the base executor and
 * persist outputs under the cache key. Failures are NOT cached.
 *
 * REF_UNRESOLVED inside cache-key derivation falls through to the
 * base executor so the proper attempt_started / attempt_failed event
 * pair still fires.
 */
function withCache(
  baseExecutor: NodeExecutor,
  cache: WorkflowCache,
  deps: WorkflowEngineDependencies,
): NodeExecutor {
  return async (nodeId, state) => {
    const node = state.spec.nodes.find((n) => n.id === nodeId);
    if (node === undefined) return baseExecutor(nodeId, state);

    // SQL nodes have no generic `input` field, and the underlying
    // `extract_dataset_by_sql` tool maintains its own L1 query cache
    // keyed by (dataSourceName, queryHash). A second cache layer on
    // top would either double-cache or fight with the tool-side
    // cache invalidation. Skip the engine cache wrapper.
    if (node.type === "sql") return baseExecutor(nodeId, state);

    // Resolve refs to derive the cache key. If resolution throws,
    // skip the cache check — the base executor will throw the same
    // error with the proper event lifecycle.
    let resolvedInput: unknown;
    try {
      resolvedInput = resolveRefs(node.input, state);
    } catch {
      return baseExecutor(nodeId, state);
    }

    const key = computeCacheKey(node, resolvedInput);
    const cached = await cache.get(key);
    if (cached !== undefined) {
      deps.emitEvent({
        type: "workflow_node_completed",
        runId: state.runId,
        nodeId,
        attempt: 0,
        durationMs: 0,
        outputs: cached,
        cached: true,
      });
      return cached;
    }

    const outputs = await baseExecutor(nodeId, state);
    await cache.set(key, outputs);
    return outputs;
  };
}
