import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type { ExecuteParams } from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import {
  runScheduler,
  type NodeExecutor,
} from "@/lib/workflows/engine/scheduler";
import type {
  CanonicalNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

function toolNode(
  id: number,
  depends_on: number[] = [],
): CanonicalNode {
  return {
    type: "tool",
    id,
    description: `n${id}`,
    depends_on,
    tool: `tool_${id}`,
    input: {},
  };
}

function makeSpec(nodes: CanonicalNode[]): CanonicalWorkflowSpec {
  return {
    version: "1.0",
    name: "demo",
    refReconAlgorithm: "ref_recon_v1",
    nodes,
    outputs: { dummy: "@nodes.0.dummy" },
  };
}

function makeState(
  spec: CanonicalWorkflowSpec,
  abortController?: AbortController,
): ExecutionState {
  const params: ExecuteParams = {
    workflowId: "wf-1",
    runId: "run-1",
    spec,
    input: {},
    context: {},
    abortController: abortController ?? new AbortController(),
  };
  return createExecutionState(params);
}

/** Build an executor whose behavior is keyed by node id. */
function executorFor(
  behavior: Record<
    number,
    | { kind: "ok"; outputs?: Record<string, unknown>; delayMs?: number }
    | { kind: "fail"; error: WorkflowError; delayMs?: number }
    | { kind: "throw-raw"; error: unknown; delayMs?: number }
  >,
  callLog?: number[],
): NodeExecutor {
  return async (nodeId) => {
    callLog?.push(nodeId);
    const b = behavior[nodeId];
    if (b === undefined) {
      throw new Error(`executor: no behavior configured for node ${nodeId}`);
    }
    if (b.delayMs !== undefined && b.delayMs > 0) {
      await new Promise((r) => setTimeout(r, b.delayMs));
    }
    if (b.kind === "fail") throw b.error;
    if (b.kind === "throw-raw") throw b.error;
    return b.outputs ?? { ok: true };
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("runScheduler — happy paths", () => {
  it("executes a single-node workflow", async () => {
    const spec = makeSpec([toolNode(0)]);
    const state = makeState(spec);
    const log: number[] = [];
    await runScheduler({
      state,
      executeNode: executorFor({ 0: { kind: "ok", outputs: { dataset: "x" } } }, log),
    });
    expect(state.completed).toEqual(new Set([0]));
    expect(state.failed.size).toBe(0);
    expect(state.skipped.size).toBe(0);
    expect(state.outputs.get(0)).toEqual({ dataset: "x" });
    expect(log).toEqual([0]);
  });

  it("respects depends_on order in a linear chain", async () => {
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [1]),
    ]);
    const state = makeState(spec);
    const log: number[] = [];
    await runScheduler({
      state,
      executeNode: executorFor({
        0: { kind: "ok" },
        1: { kind: "ok" },
        2: { kind: "ok" },
      }, log),
    });
    expect(log).toEqual([0, 1, 2]);
    expect(state.completed).toEqual(new Set([0, 1, 2]));
  });

  it("runs independent nodes in parallel (diamond DAG)", async () => {
    // 0 → 1, 0 → 2, 1+2 → 3.  Nodes 1 and 2 should run in the same batch.
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [0]),
      toolNode(3, [1, 2]),
    ]);
    const state = makeState(spec);
    const concurrentLog: number[][] = [];
    let currentlyRunning: number[] = [];

    const executor: NodeExecutor = async (nodeId) => {
      currentlyRunning.push(nodeId);
      concurrentLog.push([...currentlyRunning]);
      // Yield to let any other parallel calls also enter before we exit.
      await new Promise((r) => setTimeout(r, 5));
      currentlyRunning = currentlyRunning.filter((x) => x !== nodeId);
      return { ok: true };
    };
    await runScheduler({ state, executeNode: executor, maxParallelism: 3 });

    expect(state.completed).toEqual(new Set([0, 1, 2, 3]));
    // At least one snapshot should have shown nodes 1 and 2 in flight together.
    const sawParallel = concurrentLog.some(
      (snap) => snap.includes(1) && snap.includes(2),
    );
    expect(sawParallel).toBe(true);
  });

  it("caps concurrency at maxParallelism", async () => {
    // 4 sibling nodes all ready at once, but cap = 2 → run in two batches of 2.
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [0]),
      toolNode(3, [0]),
      toolNode(4, [0]),
    ]);
    const state = makeState(spec);
    let maxInFlight = 0;
    let inFlight = 0;
    const executor: NodeExecutor = async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true };
    };
    await runScheduler({ state, executeNode: executor, maxParallelism: 2 });
    expect(state.completed.size).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("uses the default max_parallelism (3) when not specified", async () => {
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [0]),
      toolNode(3, [0]),
      toolNode(4, [0]),
    ]);
    const state = makeState(spec);
    let maxInFlight = 0;
    let inFlight = 0;
    const executor: NodeExecutor = async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true };
    };
    await runScheduler({ state, executeNode: executor }); // default = 3
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

// ─── on_failure: "stop" (default) ─────────────────────────────────────

describe("runScheduler — on_failure: 'stop' (default)", () => {
  it("marks all remaining nodes as skipped when a node fails", async () => {
    // 0 → 1 → 2; node 0 fails.  Both 1 and 2 should be skipped.
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [1]),
    ]);
    const state = makeState(spec);
    const executor = executorFor({
      0: {
        kind: "fail",
        error: new WorkflowError({
          errorCode: "TOOL_EXECUTION_FAILED",
          message: "tool failed",
          nodeId: 0,
        }),
      },
    });
    await runScheduler({ state, executeNode: executor });
    expect(state.failed).toEqual(new Set([0]));
    expect(state.skipped).toEqual(new Set([1, 2]));
    expect(state.completed.size).toBe(0);
  });

  it("skips even independent parallel nodes when one in the batch fails (stop mode)", async () => {
    // 0 → 1, 0 → 2.  Node 1 fails. Node 2 might have completed
    // already in the same batch (Promise.all), but if there were
    // downstream-of-2 nodes they'd be skipped.
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [0]),
      toolNode(3, [2]),
    ]);
    const state = makeState(spec);
    const err = new WorkflowError({
      errorCode: "TOOL_EXECUTION_FAILED",
      message: "fail",
      nodeId: 1,
    });
    await runScheduler({
      state,
      executeNode: executorFor({
        0: { kind: "ok" },
        1: { kind: "fail", error: err },
        2: { kind: "ok" },
        3: { kind: "ok" }, // never reached
      }),
    });
    expect(state.failed).toEqual(new Set([1]));
    expect(state.skipped.has(3)).toBe(true);
    // Node 0 and 2 may both be completed (in different batches).
    expect(state.completed.has(0)).toBe(true);
  });

  it("records the original WorkflowError in state.nodeErrors", async () => {
    const spec = makeSpec([toolNode(0)]);
    const state = makeState(spec);
    const err = new WorkflowError({
      errorCode: "PYTHON_RUNTIME_ERROR",
      message: "boom",
      nodeId: 0,
    });
    await runScheduler({
      state,
      executeNode: executorFor({ 0: { kind: "fail", error: err } }),
    });
    expect(state.nodeErrors.get(0)).toBe(err);
  });

  it("wraps non-WorkflowError throwables as UNKNOWN_ERROR with cause + nodeName", async () => {
    const spec = makeSpec([toolNode(0)]);
    const state = makeState(spec);
    const raw = new Error("native failure");
    await runScheduler({
      state,
      executeNode: executorFor({ 0: { kind: "throw-raw", error: raw } }),
    });
    const recorded = state.nodeErrors.get(0);
    expect(recorded).toBeInstanceOf(WorkflowError);
    expect(recorded!.errorCode).toBe("UNKNOWN_ERROR");
    expect(recorded!.nodeId).toBe(0);
    expect(recorded!.nodeName).toBe("tool_0");
    expect(recorded!.message).toBe("native failure");
    expect(recorded!.cause).toBe(raw);
  });
});

// ─── on_failure: "continue" ───────────────────────────────────────────

describe("runScheduler — on_failure: 'continue'", () => {
  it("keeps running independent paths after a node fails", async () => {
    // Two independent branches: 0 fails alone, 1→2 succeeds.
    const spec = makeSpec([
      toolNode(0),
      toolNode(1),
      toolNode(2, [1]),
    ]);
    const state = makeState(spec);
    await runScheduler({
      state,
      onFailure: "continue",
      executeNode: executorFor({
        0: {
          kind: "fail",
          error: new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: "x",
            nodeId: 0,
          }),
        },
        1: { kind: "ok" },
        2: { kind: "ok" },
      }),
    });
    expect(state.failed).toEqual(new Set([0]));
    expect(state.completed).toEqual(new Set([1, 2]));
    expect(state.skipped.size).toBe(0);
  });

  it("skips only the failed node's transitive forward closure", async () => {
    // 0 → 1 → 2; 3 (independent).  Node 0 fails.
    // Expect: 0 failed, 1 + 2 skipped (downstream), 3 completed (independent).
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [1]),
      toolNode(3),
    ]);
    const state = makeState(spec);
    await runScheduler({
      state,
      onFailure: "continue",
      executeNode: executorFor({
        0: {
          kind: "fail",
          error: new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: "x",
            nodeId: 0,
          }),
        },
        1: { kind: "ok" },
        2: { kind: "ok" },
        3: { kind: "ok" },
      }),
    });
    expect(state.failed).toEqual(new Set([0]));
    expect(state.skipped).toEqual(new Set([1, 2]));
    expect(state.completed).toEqual(new Set([3]));
  });
});

// ─── AbortSignal handling ─────────────────────────────────────────────

describe("runScheduler — AbortSignal", () => {
  it("does not start any node when signal is already aborted", async () => {
    const spec = makeSpec([toolNode(0)]);
    const ac = new AbortController();
    ac.abort();
    const state = makeState(spec, ac);
    const log: number[] = [];
    await runScheduler({
      state,
      executeNode: executorFor({ 0: { kind: "ok" } }, log),
    });
    expect(log).toEqual([]);
    expect(state.completed.size).toBe(0);
    expect(state.failed.size).toBe(0);
    expect(state.skipped.size).toBe(0);
  });

  it("stops dispatching new batches once signal fires mid-run", async () => {
    // 0 → 1 → 2.  After node 0 completes, fire abort.  Node 1 must
    // not be dispatched (signal checked at batch boundary).
    const spec = makeSpec([
      toolNode(0),
      toolNode(1, [0]),
      toolNode(2, [1]),
    ]);
    const ac = new AbortController();
    const state = makeState(spec, ac);
    const log: number[] = [];
    const executor: NodeExecutor = async (nodeId) => {
      log.push(nodeId);
      if (nodeId === 0) ac.abort();
      return { ok: true };
    };
    await runScheduler({ state, executeNode: executor });
    expect(log).toEqual([0]); // node 1 + 2 never dispatched
    expect(state.completed).toEqual(new Set([0]));
  });
});
