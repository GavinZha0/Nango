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
import type {
  CanonicalAgentNode,
  CanonicalChartNode,
  CanonicalCodeNode,
  CanonicalNode,
  CanonicalSqlNode,
  CanonicalToolNode,
  CanonicalWorkflowSpec,
} from "../spec/schema";
import { executeAgentNode } from "../nodes/agent-node";
import { executeChartNode } from "../nodes/chart-node";
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

// ─── Executor table: (type:version) → executor ─────────────────────────

/**
 * Type-erased wrapper for a node executor. The table key guarantees the
 * node passed at runtime has the correct subtype; the `as` casts inside
 * each entry are safe because `validate.ts::validateExecutorKeys` checked
 * the same key at save time.
 */
type AnyNodeExecutorFn = (
  node: CanonicalNode,
  state: ExecutionState,
  deps: WorkflowEngineDependencies,
) => Promise<Record<string, unknown>>;

/**
 * Registry of all `"<type>:<schema_version>"` executors this build
 * supports. When a breaking schema change bumps a version:
 *   1. Add the new `"<type>:<newVersion>"` entry.
 *   2. KEEP the old `"<type>:<oldVersion>"` entry — persisted workflows
 *      must keep running.
 *   3. Update `SUPPORTED_EXECUTOR_KEYS` in `spec/canonicalize.ts` to
 *      match (both current + legacy).
 *
 * `validate.ts::validateExecutorKeys` ensures every spec saved against
 * this build has a matching entry here, so `SCHEMA_VERSION_UNKNOWN` is
 * caught at save time rather than at refresh time.
 */
const NODE_EXECUTOR_TABLE: Record<string, AnyNodeExecutorFn> = {
  "tool:1":  (n, s, d) => executeToolNode(n as CanonicalToolNode, s, d),
  "agent:1": (n, s, d) => executeAgentNode(n as CanonicalAgentNode, s, d),
  "code:1":  (n, s, d) => executeCodeNode(n as CanonicalCodeNode, s, d),
  "sql:1":   (n, s, d) => executeSqlNode(n as CanonicalSqlNode, s, d),
  "chart:1": (n, s, d) => executeChartNode(n as CanonicalChartNode, s, d),
};

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
    const key = `${node.type}:${node.schema_version}`;
    const executor = NODE_EXECUTOR_TABLE[key];
    if (executor === undefined) {
      // validate.ts::validateExecutorKeys should have caught this at save
      // time. Reaching here means either the spec bypassed the save
      // pipeline or was persisted by a newer build.
      throw new WorkflowError({
        errorCode: "SCHEMA_VERSION_UNKNOWN",
        message:
          `Node ${nodeId}: no executor registered for "${key}". ` +
          `This build supports: ${Object.keys(NODE_EXECUTOR_TABLE).join(", ")}.`,
        nodeId,
        nodeName: key,
      });
    }
    return executor(node, state, deps);
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

    // Chart nodes are pure in-memory config transforms with no
    // network I/O. Their inputs.config can reach the
    // CHART_CONFIG_TOO_LARGE cap (64 KB) for not-refreshable charts,
    // which would produce oversized cache keys. The transform is fast
    // enough that caching adds no value.
    if (node.type === "chart") return baseExecutor(nodeId, state);

    // Resolve refs to derive the cache key. If resolution throws,
    // skip the cache check — the base executor will throw the same
    // error with the proper event lifecycle.
    let resolvedInput: unknown;
    try {
      resolvedInput = resolveRefs(node.inputs, state);
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
