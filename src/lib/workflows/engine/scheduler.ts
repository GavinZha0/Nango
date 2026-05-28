/**
 * Topological + parallel-batch scheduler — the engine's "DAG
 * runner" body, separate from the per-node executor (which lives
 * in `nodes/`). Pure orchestration:
 *
 *   - Find nodes whose `depends_on` are all completed → ready
 *   - Dispatch up to `maxParallelism` ready nodes in a Promise.all
 *     batch
 *   - When a node throws, record it as failed (state.failed +
 *     state.nodeErrors); on the chosen `onFailure` policy either
 *     abort the rest of the run ("stop") or mark only that node's
 *     transitive forward closure as skipped ("continue") and keep
 *     dispatching independent paths
 *   - Honor `AbortSignal` at batch boundaries (in-flight executors
 *     are responsible for plumbing the same signal into their IO
 *     primitives)
 *
 * The scheduler does NOT execute nodes itself — it calls a
 * caller-supplied `NodeExecutor` (`(nodeId, state) => Promise<
 * Record<string, unknown>>`). The executor returns the node's
 * outputs on success or throws `WorkflowError` on failure. This
 * keeps the scheduler 100% testable with stubbed executors and
 * decouples it from the tool / agent dispatch surface
 * (`nodes/tool-node.ts`, `nodes/agent-node.ts`).
 *
 * V1 simplifications (D23 — condition nodes deferred):
 *   - No dynamic edges; depends_on is the full edge set.
 *   - No SKIP convergence / needTable. (V1.1 adds these when
 *     condition nodes ship.)
 *
 * See `docs/workflow-architecture.md` §7.1 for the full design
 * (incl. V1.1 dynamic-edge layer).
 */

import { WorkflowError } from "../error";
import type { CanonicalWorkflowSpec } from "../spec/schema";
import type { ExecutionState } from "./execution-context";

// ─── Public surface ────────────────────────────────────────────────────

/**
 * Per-node executor signature — pure data in / data out.
 *
 * Success path: returns the node's `outputs` object; scheduler
 * stamps it into `state.outputs` and adds the id to
 * `state.completed`.
 *
 * Failure path: throws `WorkflowError` (or anything else — the
 * scheduler wraps non-WorkflowError throwables as `UNKNOWN_ERROR`).
 * The scheduler stamps the id into `state.failed` and the error
 * into `state.nodeErrors`.
 */
export type NodeExecutor = (
  nodeId: number,
  state: ExecutionState,
) => Promise<Record<string, unknown>>;

export interface ScheduleParams {
  state: ExecutionState;
  executeNode: NodeExecutor;
  /** V1 default: 3 (matches §6.4 + `workflow.execution.default_max_parallelism`). */
  maxParallelism?: number;
  /** V1 default: "stop". */
  onFailure?: "stop" | "continue";
}

/**
 * Drive the DAG to terminal state. Returns when:
 *   - every node is completed/failed/skipped, OR
 *   - `state.abortSignal` fires (in-flight batch still completes), OR
 *   - on_failure="stop" and a batch produced any failure
 *
 * Mutates `state` only. Never throws — failures are recorded into
 * `state.nodeErrors` and the caller (engine layer) inspects after
 * return.
 */
export async function runScheduler(params: ScheduleParams): Promise<void> {
  const {
    state,
    executeNode,
    maxParallelism = DEFAULT_MAX_PARALLELISM,
    onFailure = "stop",
  } = params;

  const graph = buildSchedulerGraph(state.spec);
  const totalNodes = state.spec.nodes.length;

  while (
    state.completed.size + state.failed.size + state.skipped.size <
    totalNodes
  ) {
    if (state.abortSignal.aborted) return;

    const ready = findReadyNodes(state);
    if (ready.length === 0) {
      // No ready nodes and not all done → defensive break. With a
      // validated DAG this means either (a) all remaining nodes are
      // blocked behind failed/skipped deps (handled below by post-
      // batch failure logic) or (b) a validate.ts contract was
      // violated upstream. Either way, no progress is possible.
      markAllRemainingSkipped(state);
      return;
    }

    const batch = ready.slice(0, maxParallelism);
    await Promise.all(
      batch.map((nodeId) => runOneNode(nodeId, state, executeNode)),
    );

    if (state.failed.size > 0) {
      if (onFailure === "stop") {
        markAllRemainingSkipped(state);
        return;
      }
      // on_failure: "continue" — mark only the forward closure of
      // each failed node as skipped so independent paths keep
      // progressing. Idempotent: re-marking already-skipped nodes
      // is a no-op (Set semantics).
      for (const failedId of state.failed) {
        markForwardClosureSkipped(failedId, graph, state);
      }
    }
  }
}

// ─── Scheduler graph ───────────────────────────────────────────────────

interface SchedulerGraph {
  /** node id → list of node ids that have this id in their depends_on. */
  dependents: Map<number, number[]>;
}

function buildSchedulerGraph(spec: CanonicalWorkflowSpec): SchedulerGraph {
  const dependents = new Map<number, number[]>();
  for (const n of spec.nodes) dependents.set(n.id, []);
  for (const n of spec.nodes) {
    for (const dep of n.depends_on) {
      dependents.get(dep)!.push(n.id);
    }
  }
  return { dependents };
}

// ─── Ready-queue logic ─────────────────────────────────────────────────

function findReadyNodes(state: ExecutionState): number[] {
  const ready: number[] = [];
  for (const node of state.spec.nodes) {
    const id = node.id;
    if (
      state.completed.has(id) ||
      state.failed.has(id) ||
      state.skipped.has(id)
    ) {
      continue;
    }
    let allDepsCompleted = true;
    for (const dep of node.depends_on) {
      if (!state.completed.has(dep)) {
        allDepsCompleted = false;
        break;
      }
    }
    if (allDepsCompleted) ready.push(id);
  }
  return ready;
}

// ─── Per-node dispatch (try/catch wrapper) ─────────────────────────────

async function runOneNode(
  nodeId: number,
  state: ExecutionState,
  executeNode: NodeExecutor,
): Promise<void> {
  try {
    const outputs = await executeNode(nodeId, state);
    state.outputs.set(nodeId, outputs);
    state.completed.add(nodeId);
  } catch (err) {
    state.failed.add(nodeId);
    state.nodeErrors.set(nodeId, wrapAsWorkflowError(err, nodeId, state));
  }
}

function wrapAsWorkflowError(
  err: unknown,
  nodeId: number,
  state: ExecutionState,
): WorkflowError {
  if (err instanceof WorkflowError) return err;
  const node = state.spec.nodes.find((n) => n.id === nodeId);
  const nodeName = nodeDisplayName(node);
  return new WorkflowError({
    errorCode: "UNKNOWN_ERROR",
    message: err instanceof Error ? err.message : String(err),
    nodeId,
    ...(nodeName !== undefined && { nodeName }),
    cause: err,
  });
}

/** Surface-friendly identifier per node type for error messages.
 *  Code nodes have no name field; use the language tag as a hint. */
function nodeDisplayName(
  node: ExecutionState["spec"]["nodes"][number] | undefined,
): string | undefined {
  if (node === undefined) return undefined;
  switch (node.type) {
    case "tool":
      return node.tool;
    case "agent":
      return node.agent;
    case "code":
      return `code:${node.language}`;
    case "sql":
      return `sql:${node.dataSourceName}`;
  }
}

// ─── Skip-propagation helpers ──────────────────────────────────────────

/**
 * Mark every not-yet-finished node as skipped. Used by the
 * on_failure="stop" branch and the defensive starvation break.
 */
function markAllRemainingSkipped(state: ExecutionState): void {
  for (const n of state.spec.nodes) {
    const id = n.id;
    if (
      !state.completed.has(id) &&
      !state.failed.has(id) &&
      !state.skipped.has(id)
    ) {
      state.skipped.add(id);
    }
  }
}

/**
 * Mark the transitive forward closure of `rootId` as skipped —
 * i.e. every node reachable by walking `dependents` edges starting
 * at the root. Used by on_failure="continue" so independent paths
 * keep running.
 */
function markForwardClosureSkipped(
  rootId: number,
  graph: SchedulerGraph,
  state: ExecutionState,
): void {
  const stack: number[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of graph.dependents.get(id) ?? []) {
      if (
        state.completed.has(next) ||
        state.failed.has(next) ||
        state.skipped.has(next)
      ) {
        continue;
      }
      state.skipped.add(next);
      stack.push(next);
    }
  }
}

// ─── Constants ─────────────────────────────────────────────────────────

/**
 * V1 default. The hard ceiling lives in the
 * `workflow.execution.default_max_parallelism` config key, read by
 * the engine layer before invoking the scheduler — keeping this
 * file config-free preserves its purity / testability.
 */
const DEFAULT_MAX_PARALLELISM = 3;
