import { describe, expect, it, vi } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type { ExecuteParams, WorkflowEngineEvent } from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import { executeToolNode, type ToolNodeDeps } from "@/lib/workflows/nodes/tool-node";
import type {
  CanonicalToolNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

/**
 * Wrap a raw args-schema in the wrapper shape canonicalize stamps
 * onto tool nodes: `{ properties: { name: const, arguments: <args> },
 * required: [name, arguments] }`. Tests for the executor's input
 * validation use this to match the production shape.
 */
function wrapToolInputSchema(
  argsSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      arguments: argsSchema,
    },
    required: ["name", "arguments"],
  };
}

function toolNode(
  overrides?: Partial<Omit<CanonicalToolNode, "type" | "inputs">> & {
    inputs?: Partial<CanonicalToolNode["inputs"]>;
  },
): CanonicalToolNode {
  const { inputs: inputsOverride, ...rest } = overrides ?? {};
  return {
    type: "tool",
    schema_version: "1",
    id: 0,
    description: "n",
    depends_on: [],
    ...rest,
    inputs: {
      name: inputsOverride?.name ?? "extract_dataset_by_sql",
      arguments: inputsOverride?.arguments ?? {
        dataSourceId: "x",
        sql: "select 1",
      },
    },
  };
}

function makeState(
  node: CanonicalToolNode,
  init?: { input?: Record<string, unknown>; outputs?: Map<number, Record<string, unknown>> },
): ExecutionState {
  const spec: CanonicalWorkflowSpec = {
    name: "demo",
    nodes: [node],
    outputs: { dummy: "@nodes.0.dummy" },
  };
  const params: ExecuteParams = {
    workflowId: "wf-1",
    runId: "run-1",
    spec,
    input: init?.input ?? {},
    context: {},
    abortController: new AbortController(),
  };
  const state = createExecutionState(params);
  if (init?.outputs) {
    for (const [id, out] of init.outputs) state.outputs.set(id, out);
  }
  return state;
}

function makeDeps(
  toolBehavior:
    | { kind: "ok"; result: unknown }
    | { kind: "missing" }
    | { kind: "throw"; error: unknown },
  events?: WorkflowEngineEvent[],
): ToolNodeDeps {
  return {
    getTool: vi.fn().mockImplementation(() => {
      if (toolBehavior.kind === "missing") return null;
      return {
        execute: vi.fn().mockImplementation(async () => {
          if (toolBehavior.kind === "throw") throw toolBehavior.error;
          return toolBehavior.result;
        }),
      };
    }),
    emitEvent: vi.fn().mockImplementation((event: WorkflowEngineEvent) => {
      events?.push(event);
    }),
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("executeToolNode — happy paths", () => {
  it("returns the tool's outputs and marks success via events", async () => {
    const node = toolNode();
    const state = makeState(node);
    const events: WorkflowEngineEvent[] = [];
    const deps = makeDeps(
      { kind: "ok", result: { dataset: "p.parquet", rowCount: 42 } },
      events,
    );
    const outputs = await executeToolNode(node, state, deps);
    expect(outputs).toEqual({ dataset: "p.parquet", rowCount: 42 });
    expect(events.map((e) => e.type)).toEqual([
      "workflow_node_attempt_started",
      "workflow_node_completed",
    ]);
  });

  it("resolves @workflow.* refs in input before calling tool.execute", async () => {
    const node = toolNode({
      inputs: {
        arguments: {
          dataSourceId: "@workflow.tenant",
          sql: "SELECT * FROM o WHERE x = '@workflow.tenant'",
        },
      },
    });
    const state = makeState(node, { input: { tenant: "acme" } });
    const captured: Record<string, unknown>[] = [];
    const deps: ToolNodeDeps = {
      getTool: () => ({
        execute: async ({ input }) => {
          captured.push(input);
          return { ok: true };
        },
      }),
      emitEvent: () => {},
    };
    await executeToolNode(node, state, deps);
    expect(captured[0]).toEqual({
      dataSourceId: "acme",
      sql: "SELECT * FROM o WHERE x = 'acme'",
    });
  });

  it("resolves @nodes.<n>.<field> refs from upstream outputs", async () => {
    const node = toolNode({
      id: 1,
      depends_on: [0],
      inputs: {
        name: "downstream_tool",
        arguments: { dataset: "@nodes.0.dataset" },
      },
    });
    const state = makeState(node, {
      outputs: new Map([[0, { dataset: "p.parquet" }]]),
    });
    let received: unknown;
    const deps: ToolNodeDeps = {
      getTool: () => ({
        execute: async ({ input }) => {
          received = input;
          return { ok: true };
        },
      }),
      emitEvent: () => {},
    };
    await executeToolNode(node, state, deps);
    expect(received).toEqual({ dataset: "p.parquet" });
  });

  it("passes state.abortSignal through to tool.execute", async () => {
    const node = toolNode();
    const ac = new AbortController();
    const spec: CanonicalWorkflowSpec = {
      name: "demo",
      nodes: [node],
      outputs: { dummy: "@nodes.0.dummy" },
    };
    const params: ExecuteParams = {
      workflowId: "wf-1",
      runId: "run-1",
      spec,
      input: {},
      context: {},
      abortController: ac,
    };
    const state = createExecutionState(params);
    let receivedSignal: AbortSignal | undefined;
    const deps: ToolNodeDeps = {
      getTool: () => ({
        execute: async ({ abortSignal }) => {
          receivedSignal = abortSignal;
          return { ok: true };
        },
      }),
      emitEvent: () => {},
    };
    await executeToolNode(node, state, deps);
    expect(receivedSignal).toBe(ac.signal);
  });

  it("emits workflow_node_completed with durationMs + outputs", async () => {
    const node = toolNode();
    const state = makeState(node);
    const events: WorkflowEngineEvent[] = [];
    await executeToolNode(
      node,
      state,
      makeDeps({ kind: "ok", result: { dataset: "x" } }, events),
    );
    const completed = events.find(
      (e) => e.type === "workflow_node_completed",
    );
    expect(completed).toBeDefined();
    if (completed?.type !== "workflow_node_completed") throw new Error();
    expect(completed.runId).toBe("run-1");
    expect(completed.nodeId).toBe(0);
    expect(completed.attempt).toBe(0);
    expect(completed.outputs).toEqual({ dataset: "x" });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── Error paths ──────────────────────────────────────────────────────

function expectWfError(
  fn: () => Promise<unknown>,
  code: string,
  match?: RegExp,
): Promise<WorkflowError> {
  return fn().then(
    () => {
      throw new Error(`Expected throw with code ${code}`);
    },
    (e: unknown) => {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe(code);
      if (match !== undefined) expect(e.message).toMatch(match);
      return e;
    },
  );
}

describe("executeToolNode — error paths", () => {
  it("throws TOOL_NOT_FOUND when getTool returns null", async () => {
    const node = toolNode();
    const state = makeState(node);
    const events: WorkflowEngineEvent[] = [];
    const e = await expectWfError(
      () =>
        executeToolNode(node, state, makeDeps({ kind: "missing" }, events)),
      "TOOL_NOT_FOUND",
      /extract_dataset_by_sql/,
    );
    expect(e.nodeId).toBe(0);
    expect(e.nodeName).toBe("extract_dataset_by_sql");
    expect(events.map((e_) => e_.type)).toEqual([
      "workflow_node_attempt_started",
      "workflow_node_attempt_failed",
    ]);
  });

  it("wraps raw thrown Error as TOOL_EXECUTION_FAILED with cause preserved", async () => {
    const node = toolNode();
    const state = makeState(node);
    const events: WorkflowEngineEvent[] = [];
    const raw = new Error("boom");
    const e = await expectWfError(
      () =>
        executeToolNode(
          node,
          state,
          makeDeps({ kind: "throw", error: raw }, events),
        ),
      "TOOL_EXECUTION_FAILED",
      /boom/,
    );
    expect(e.nodeId).toBe(0);
    expect(e.nodeName).toBe("extract_dataset_by_sql");
    expect(e.cause).toBe(raw);
    const failedEvent = events.find(
      (ev) => ev.type === "workflow_node_attempt_failed",
    );
    if (failedEvent?.type !== "workflow_node_attempt_failed") throw new Error();
    expect(failedEvent.errorCode).toBe("TOOL_EXECUTION_FAILED");
  });

  it("passes WorkflowError through unchanged (no double-wrapping)", async () => {
    const node = toolNode();
    const state = makeState(node);
    const inner = new WorkflowError({
      errorCode: "SQL_SYNTAX_ERROR",
      message: "syntax",
      nodeId: 0,
      nodeName: "extract_dataset_by_sql",
    });
    const e = await expectWfError(
      () =>
        executeToolNode(
          node,
          state,
          makeDeps({ kind: "throw", error: inner }),
        ),
      "SQL_SYNTAX_ERROR",
    );
    expect(e).toBe(inner);
  });

  it("propagates REF_UNRESOLVED from ref resolution (before tool.execute)", async () => {
    const node = toolNode({
      inputs: {
        arguments: { dataSourceId: "@workflow.missing", sql: "x" },
      },
    });
    const state = makeState(node, { input: {} });
    const events: WorkflowEngineEvent[] = [];
    let executeCalled = false;
    const deps: ToolNodeDeps = {
      getTool: () => ({
        execute: async () => {
          executeCalled = true;
          return { ok: true };
        },
      }),
      emitEvent: (e) => events.push(e),
    };
    await expectWfError(
      () => executeToolNode(node, state, deps),
      "REF_UNRESOLVED",
    );
    expect(executeCalled).toBe(false); // tool never reached
    expect(events.map((e) => e.type)).toEqual([
      "workflow_node_attempt_started",
      "workflow_node_attempt_failed",
    ]);
  });

  it("throws TOOL_EXECUTION_FAILED when tool returns a non-object result", async () => {
    const node = toolNode();
    const state = makeState(node);
    const e = await expectWfError(
      () =>
        executeToolNode(
          node,
          state,
          makeDeps({ kind: "ok", result: "raw string" }),
        ),
      "TOOL_EXECUTION_FAILED",
      /non-object/,
    );
    expect(e.message).toContain("string");
  });

  it("throws TOOL_EXECUTION_FAILED when tool returns an array", async () => {
    const node = toolNode();
    const state = makeState(node);
    await expectWfError(
      () =>
        executeToolNode(
          node,
          state,
          makeDeps({ kind: "ok", result: [1, 2, 3] }),
        ),
      "TOOL_EXECUTION_FAILED",
      /non-object.*array/,
    );
  });

  it("throws TOOL_EXECUTION_FAILED when tool returns null", async () => {
    const node = toolNode();
    const state = makeState(node);
    await expectWfError(
      () =>
        executeToolNode(node, state, makeDeps({ kind: "ok", result: null })),
      "TOOL_EXECUTION_FAILED",
      /non-object.*null/,
    );
  });
});

// ─── Schema validation (W1.4.6) ───────────────────────────────────────

describe("executeToolNode — input schema validation", () => {
  it("throws TOOL_INPUT_SCHEMA_MISMATCH when resolved input is missing required keys", async () => {
    const node = toolNode({
      // Wrapper schema mirrors what canonicalize stamps: the args
      // schema lives under properties.arguments. The executor reads
      // it via extractArgsSchema().
      input_schema: wrapToolInputSchema({
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      }),
      inputs: { arguments: {} }, // missing 'sql'
    });
    const state = makeState(node);
    let toolCalled = false;
    const deps: ToolNodeDeps = {
      getTool: () => ({
        execute: async () => {
          toolCalled = true;
          return { ok: true };
        },
      }),
      emitEvent: () => {},
    };
    const e = await expectWfError(
      () => executeToolNode(node, state, deps),
      "TOOL_INPUT_SCHEMA_MISMATCH",
      /sql/,
    );
    expect(e.nodeId).toBe(0);
    expect(toolCalled).toBe(false); // never reached the tool
  });

  it("throws TOOL_INPUT_SCHEMA_MISMATCH on type mismatch after ref resolution", async () => {
    const node = toolNode({
      input_schema: wrapToolInputSchema({
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      }),
      inputs: { arguments: { count: "@workflow.count_str" } },
    });
    const state = makeState(node, { input: { count_str: "not-a-number" } });
    await expectWfError(
      () =>
        executeToolNode(node, state, makeDeps({ kind: "ok", result: { ok: true } })),
      "TOOL_INPUT_SCHEMA_MISMATCH",
      /count/,
    );
  });

  it("passes when input_schema is undefined (back-compat)", async () => {
    const node = toolNode({
      inputs: { arguments: { anything: "goes" } },
    });
    const state = makeState(node);
    await expect(
      executeToolNode(
        node,
        state,
        makeDeps({ kind: "ok", result: { dataset: "x" } }),
      ),
    ).resolves.toEqual({ dataset: "x" });
  });
});

describe("executeToolNode — output schema validation", () => {
  it("throws TOOL_EXECUTION_FAILED when tool output is missing required keys", async () => {
    const node = toolNode({
      output_schema: {
        type: "object",
        properties: {
          dataset: { type: "string" },
          rowCount: { type: "integer" },
        },
        required: ["dataset", "rowCount"],
      },
    });
    const state = makeState(node);
    await expectWfError(
      () =>
        executeToolNode(
          node,
          state,
          makeDeps({ kind: "ok", result: { dataset: "x" } }), // missing rowCount
        ),
      "TOOL_EXECUTION_FAILED",
      /rowCount/,
    );
  });

  it("throws TOOL_EXECUTION_FAILED when tool output has wrong type", async () => {
    const node = toolNode({
      output_schema: {
        type: "object",
        properties: { rowCount: { type: "integer" } },
        required: ["rowCount"],
      },
    });
    const state = makeState(node);
    await expectWfError(
      () =>
        executeToolNode(
          node,
          state,
          makeDeps({ kind: "ok", result: { rowCount: "ten" } }),
        ),
      "TOOL_EXECUTION_FAILED",
      /rowCount/,
    );
  });

  it("passes when output_schema is undefined (back-compat)", async () => {
    const node = toolNode();
    const state = makeState(node);
    await expect(
      executeToolNode(
        node,
        state,
        makeDeps({ kind: "ok", result: { whatever: 1 } }),
      ),
    ).resolves.toEqual({ whatever: 1 });
  });
});
