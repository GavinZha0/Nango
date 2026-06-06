import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type {
  ExecuteParams,
  WorkflowEngineEvent,
} from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import { executeToolNode } from "@/lib/workflows/nodes/tool-node";
import type {
  CanonicalToolNode,
  CanonicalWorkflowSpec,
  Retries,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

function toolNode(retries?: Retries): CanonicalToolNode {
  return {
    type: "tool",
    schema_version: "1",
    id: 0,
    description: "n",
    depends_on: [],
    tool: "flaky_tool",
    inputs: {},
    ...(retries !== undefined && { retries }),
  };
}

function makeState(
  node: CanonicalToolNode,
  abortController?: AbortController,
): ExecutionState {
  const spec: CanonicalWorkflowSpec = {
    version: "1.0",
    name: "demo",
    ref_recon_algorithm: "ref_recon_v1",
    nodes: [node],
    outputs: { dummy: "@nodes.0.dummy" },
  };
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

/**
 * Build a tool dependency whose execute fails for the first N
 * calls, then succeeds. Captures every call for inspection.
 */
function failingThenSuccessTool(failures: number, finalResult: Record<string, unknown>) {
  let calls = 0;
  const events: WorkflowEngineEvent[] = [];
  return {
    getTool: () => ({
      execute: async () => {
        calls++;
        if (calls <= failures) throw new Error(`transient #${calls}`);
        return finalResult;
      },
    }),
    emitEvent: (e: WorkflowEngineEvent) => events.push(e),
    get callCount(): number {
      return calls;
    },
    get events(): WorkflowEngineEvent[] {
      return events;
    },
  };
}

// ─── Default policy ───────────────────────────────────────────────────

describe("withRetries — default policy (attempts: 0)", () => {
  it("does not retry when retries is undefined", async () => {
    const node = toolNode();
    const state = makeState(node);
    const harness = failingThenSuccessTool(1, { ok: true });
    await expect(executeToolNode(node, state, harness)).rejects.toBeInstanceOf(
      WorkflowError,
    );
    expect(harness.callCount).toBe(1); // single try, no retry
    expect(harness.events.map((e) => e.type)).toEqual([
      "workflow_node_attempt_started",
      "workflow_node_attempt_failed",
    ]);
  });

  it("does not retry when attempts is 0 explicitly", async () => {
    const node = toolNode({ attempts: 0, delay_seconds: 5 });
    const state = makeState(node);
    const harness = failingThenSuccessTool(1, { ok: true });
    await expect(executeToolNode(node, state, harness)).rejects.toBeInstanceOf(
      WorkflowError,
    );
    expect(harness.callCount).toBe(1);
  });
});

// ─── Retry success ────────────────────────────────────────────────────

describe("withRetries — retry until success", () => {
  it("retries up to `attempts` times and succeeds on a later attempt", async () => {
    const node = toolNode({ attempts: 3, delay_seconds: 0 });
    const state = makeState(node);
    const harness = failingThenSuccessTool(2, { dataset: "p" });
    const result = await executeToolNode(node, state, harness);
    expect(result).toEqual({ dataset: "p" });
    expect(harness.callCount).toBe(3); // 1 initial + 2 retries
    // Events: started/failed (a=0) → started/failed (a=1) → started/completed (a=2)
    expect(harness.events.map((e) => e.type)).toEqual([
      "workflow_node_attempt_started",
      "workflow_node_attempt_failed",
      "workflow_node_attempt_started",
      "workflow_node_attempt_failed",
      "workflow_node_attempt_started",
      "workflow_node_completed",
    ]);
  });

  it("attempt counter increments correctly across retries", async () => {
    const node = toolNode({ attempts: 2, delay_seconds: 0 });
    const state = makeState(node);
    const harness = failingThenSuccessTool(2, { ok: true });
    await executeToolNode(node, state, harness);
    const attempts = harness.events
      .filter(
        (e) =>
          e.type === "workflow_node_attempt_started" ||
          e.type === "workflow_node_attempt_failed" ||
          e.type === "workflow_node_completed",
      )
      .map((e) =>
        // All three event variants carry `attempt`.
        (e as { attempt: number }).attempt,
      );
    expect(attempts).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

// ─── Retry exhaustion ─────────────────────────────────────────────────

describe("withRetries — retry exhaustion", () => {
  it("throws the wrapped error after all attempts fail", async () => {
    const node = toolNode({ attempts: 2, delay_seconds: 0 });
    const state = makeState(node);
    const harness = failingThenSuccessTool(99, { ok: true });
    await expect(executeToolNode(node, state, harness)).rejects.toMatchObject({
      errorCode: "TOOL_EXECUTION_FAILED",
    });
    expect(harness.callCount).toBe(3); // 1 + 2 retries
    expect(harness.events.filter((e) => e.type === "workflow_node_attempt_failed")).toHaveLength(3);
    expect(harness.events.filter((e) => e.type === "workflow_node_completed")).toHaveLength(0);
  });
});

// ─── Backoff ──────────────────────────────────────────────────────────

describe("withRetries — backoff", () => {
  it("fixed backoff: same delay between every attempt", async () => {
    const node = toolNode({ attempts: 2, delay_seconds: 1, backoff: "fixed" });
    const state = makeState(node);
    const timestamps: number[] = [];
    const deps = {
      getTool: () => ({
        execute: async () => {
          timestamps.push(Date.now());
          throw new Error("always fails");
        },
      }),
      emitEvent: () => {},
    };
    const before = Date.now();
    await expect(executeToolNode(node, state, deps)).rejects.toBeTruthy();
    // 3 attempts: gaps should be approximately 1000ms each (we
    // measure conservatively to avoid flakes on slow CI).
    expect(timestamps).toHaveLength(3);
    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    expect(gap1).toBeGreaterThanOrEqual(900);
    expect(gap1).toBeLessThan(2000);
    expect(gap2).toBeGreaterThanOrEqual(900);
    expect(gap2).toBeLessThan(2000);
    const total = Date.now() - before;
    expect(total).toBeGreaterThanOrEqual(1800);
  }, 10000);

  it("exponential backoff: 2^attempt * base", async () => {
    const node = toolNode({
      attempts: 2,
      delay_seconds: 1,
      backoff: "exponential",
    });
    const state = makeState(node);
    const timestamps: number[] = [];
    const deps = {
      getTool: () => ({
        execute: async () => {
          timestamps.push(Date.now());
          throw new Error("always fails");
        },
      }),
      emitEvent: () => {},
    };
    await expect(executeToolNode(node, state, deps)).rejects.toBeTruthy();
    expect(timestamps).toHaveLength(3);
    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    // gap1 = 1s * 2^0 = 1s; gap2 = 1s * 2^1 = 2s
    expect(gap1).toBeGreaterThanOrEqual(900);
    expect(gap1).toBeLessThan(2000);
    expect(gap2).toBeGreaterThanOrEqual(1800);
    expect(gap2).toBeLessThan(3000);
  }, 10000);
});

// ─── Abort during retry ───────────────────────────────────────────────

describe("withRetries — AbortSignal", () => {
  it("throws WORKFLOW_TIMEOUT when aborted before the first attempt", async () => {
    const node = toolNode({ attempts: 5, delay_seconds: 0 });
    const ac = new AbortController();
    ac.abort();
    const state = makeState(node, ac);
    const harness = failingThenSuccessTool(0, { ok: true });
    await expect(executeToolNode(node, state, harness)).rejects.toMatchObject({
      errorCode: "WORKFLOW_TIMEOUT",
      nodeId: 0,
    });
    expect(harness.callCount).toBe(0);
  });

  it("stops retrying when aborted during sleep", async () => {
    const node = toolNode({
      attempts: 5,
      delay_seconds: 10, // long enough to abort during sleep
    });
    const ac = new AbortController();
    const state = makeState(node, ac);
    let calls = 0;
    const deps = {
      getTool: () => ({
        execute: async () => {
          calls++;
          if (calls === 1) {
            // After first failure, schedule abort during the sleep.
            setTimeout(() => ac.abort(), 50);
            throw new Error("transient");
          }
          throw new Error("should not be reached");
        },
      }),
      emitEvent: () => {},
    };
    const before = Date.now();
    await expect(executeToolNode(node, state, deps)).rejects.toMatchObject({
      errorCode: "WORKFLOW_TIMEOUT",
    });
    expect(calls).toBe(1); // first attempt only
    // Should NOT have waited the full 10s.
    expect(Date.now() - before).toBeLessThan(1000);
  }, 5000);

  it("WorkflowError passed through unchanged across retries (no double-wrap)", async () => {
    const node = toolNode({ attempts: 2, delay_seconds: 0 });
    const state = makeState(node);
    const inner = new WorkflowError({
      errorCode: "SQL_PERMISSION_DENIED",
      message: "no",
      nodeId: 0,
      nodeName: "flaky_tool",
    });
    const deps = {
      getTool: () => ({
        execute: async () => {
          throw inner;
        },
      }),
      emitEvent: () => {},
    };
    const promise = executeToolNode(node, state, deps);
    await expect(promise).rejects.toBe(inner);
  });
});
