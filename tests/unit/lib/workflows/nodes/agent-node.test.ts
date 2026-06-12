import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type {
  AgentRunRequest,
  AgentRunResult,
  ExecuteParams,
  WorkflowEngineEvent,
} from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import {
  executeAgentNode,
  type AgentNodeDeps,
} from "@/lib/workflows/nodes/agent-node";
import type {
  CanonicalAgentNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

const AGENT_UUID = "11111111-1111-4111-8111-111111111111";

function agentNode(
  overrides?: Partial<Omit<CanonicalAgentNode, "type" | "inputs">> & {
    inputs?: Partial<CanonicalAgentNode["inputs"]>;
  },
): CanonicalAgentNode {
  const { inputs: inputsOverride, ...rest } = overrides ?? {};
  return {
    type: "agent",
    schema_version: "1",
    id: 0,
    description: "n",
    depends_on: [],
    ...rest,
    inputs: {
      name: inputsOverride?.name ?? "Builtin / DataAnalyst",
      agent_id: inputsOverride?.agent_id ?? AGENT_UUID,
      task: inputsOverride?.task ?? "Summarise dataset x",
      ...(inputsOverride?.context !== undefined && {
        context: inputsOverride.context,
      }),
    },
  };
}

function makeState(
  node: CanonicalAgentNode,
  init?: {
    input?: Record<string, unknown>;
    outputs?: Map<number, Record<string, unknown>>;
    abortController?: AbortController;
  },
): ExecutionState {
  const spec: CanonicalWorkflowSpec = {
    name: "demo",
    nodes: [node],
    outputs: { result: ".0.result" },
  };
  const params: ExecuteParams = {
    workflowId: "wf-1",
    runId: "run-1",
    spec,
    input: init?.input ?? {},
    context: {},
    abortController: init?.abortController ?? new AbortController(),
  };
  const state = createExecutionState(params);
  if (init?.outputs) {
    for (const [id, out] of init.outputs) state.outputs.set(id, out);
  }
  return state;
}

function makeDeps(
  agentBehavior:
    | { kind: "ok"; output: Record<string, unknown> }
    | { kind: "throw"; error: unknown },
  captured?: {
    requests?: AgentRunRequest[];
    events?: WorkflowEngineEvent[];
  },
): AgentNodeDeps {
  return {
    runAgent: async (req: AgentRunRequest): Promise<AgentRunResult> => {
      captured?.requests?.push(req);
      if (agentBehavior.kind === "throw") throw agentBehavior.error;
      return { output: agentBehavior.output, childRunId: "child-run-1" };
    },
    emitEvent: (event: WorkflowEngineEvent) => {
      captured?.events?.push(event);
    },
  };
}

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

// ─── Happy paths ──────────────────────────────────────────────────────

describe("executeAgentNode — happy paths", () => {
  it("returns agent's structured output and emits success events", async () => {
    const node = agentNode();
    const state = makeState(node);
    const captured = {
      requests: [] as AgentRunRequest[],
      events: [] as WorkflowEngineEvent[],
    };
    const outputs = await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "all good" } }, captured),
    );
    expect(outputs).toEqual({ result: "all good" });
    expect(captured.events.map((e) => e.type)).toEqual([
      "workflow_node_attempt_started",
      "workflow_node_completed",
    ]);
  });

  it("passes agentId (D27) — not the display string — as dispatch target", async () => {
    const node = agentNode();
    const state = makeState(node);
    const captured = { requests: [] as AgentRunRequest[] };
    await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "x" } }, captured),
    );
    expect(captured.requests[0]!.agentId).toBe(AGENT_UUID);
  });

  it("passes the registry-fixed output_schema to runAgent", async () => {
    const node = agentNode();
    const state = makeState(node);
    const captured = { requests: [] as AgentRunRequest[] };
    await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "ok" } }, captured),
    );
    // Agent nodes always use the registry's canonical output schema: { result: string }
    expect(captured.requests[0]!.outputSchema).toMatchObject({
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    });
  });

  it("sets excludeFrontendTools: true (D16 marker)", async () => {
    const node = agentNode();
    const state = makeState(node);
    const captured = { requests: [] as AgentRunRequest[] };
    await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "x" } }, captured),
    );
    expect(captured.requests[0]!.excludeFrontendTools).toBe(true);
  });

  it("plumbs state.runId as parentRunId (run-tree linkage)", async () => {
    const node = agentNode();
    const state = makeState(node);
    const captured = { requests: [] as AgentRunRequest[] };
    await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "x" } }, captured),
    );
    expect(captured.requests[0]!.parentRunId).toBe("run-1");
  });

  it("plumbs state.abortSignal into the runAgent request", async () => {
    const ac = new AbortController();
    const node = agentNode();
    const state = makeState(node, { abortController: ac });
    const captured = { requests: [] as AgentRunRequest[] };
    await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "x" } }, captured),
    );
    expect(captured.requests[0]!.abortSignal).toBe(ac.signal);
  });

  it("resolves @path refs in inputs.task / inputs.context before dispatch", async () => {
    const node = agentNode({
      inputs: {
        task: "@nodes.5.dataset",
        context: "@workflow.tenant",
      },
    });
    const state = makeState(node, {
      input: { tenant: "acme" },
      outputs: new Map([[5, { dataset: "p.parquet" }]]),
    });
    const captured = { requests: [] as AgentRunRequest[] };
    await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "x" } }, captured),
    );
    expect(captured.requests[0]!.input).toEqual({
      task: "p.parquet",
      context: "acme",
    });
  });
});

// ─── Error paths ──────────────────────────────────────────────────────

describe("executeAgentNode — error paths", () => {
  it("wraps raw thrown Error as AGENT_EXECUTION_FAILED with cause", async () => {
    const node = agentNode();
    const state = makeState(node);
    const raw = new Error("agent crashed");
    const captured = { events: [] as WorkflowEngineEvent[] };
    const e = await expectWfError(
      () =>
        executeAgentNode(
          node,
          state,
          makeDeps({ kind: "throw", error: raw }, captured),
        ),
      "AGENT_EXECUTION_FAILED",
      /agent crashed/,
    );
    expect(e.nodeId).toBe(0);
    expect(e.nodeName).toBe("Builtin / DataAnalyst");
    expect(e.cause).toBe(raw);
    expect(captured.events.map((ev) => ev.type)).toEqual([
      "workflow_node_attempt_started",
      "workflow_node_attempt_failed",
    ]);
  });

  it("passes WorkflowError through unchanged (no double-wrapping)", async () => {
    const node = agentNode();
    const state = makeState(node);
    const inner = new WorkflowError({
      errorCode: "OUTPUT_SCHEMA_MISMATCH",
      message: "agent output didn't match schema",
      nodeId: 0,
      nodeName: "Builtin / DataAnalyst",
    });
    const e = await expectWfError(
      () =>
        executeAgentNode(
          node,
          state,
          makeDeps({ kind: "throw", error: inner }),
        ),
      "OUTPUT_SCHEMA_MISMATCH",
    );
    expect(e).toBe(inner);
  });

  it("propagates REF_UNRESOLVED before invoking runAgent", async () => {
    const node = agentNode({
      inputs: { task: "@workflow.missing" },
    });
    const state = makeState(node, { input: {} });
    let runAgentCalled = false;
    const deps: AgentNodeDeps = {
      runAgent: async () => {
        runAgentCalled = true;
        return { output: { result: "x" }, childRunId: "c" };
      },
      emitEvent: () => {},
    };
    await expectWfError(
      () => executeAgentNode(node, state, deps),
      "REF_UNRESOLVED",
    );
    expect(runAgentCalled).toBe(false);
  });
});

// ─── Output schema validation (W1.4.6) ────────────────────────────────

describe("executeAgentNode — output schema validation", () => {
  it("throws OUTPUT_SCHEMA_MISMATCH when agent output is missing required keys", async () => {
    const node = agentNode();
    const state = makeState(node);
    const e = await expectWfError(
      () =>
        executeAgentNode(
          node,
          state,
          makeDeps({ kind: "ok", output: {} }), // missing 'result'
        ),
      "OUTPUT_SCHEMA_MISMATCH",
      /result/,
    );
    expect(e.nodeId).toBe(0);
    expect(e.nodeName).toBe("Builtin / DataAnalyst");
  });

  it("throws OUTPUT_SCHEMA_MISMATCH when agent output has wrong type", async () => {
    const node = agentNode();
    const state = makeState(node);
    await expectWfError(
      () =>
        executeAgentNode(
          node,
          state,
          makeDeps({ kind: "ok", output: { result: 42 } }), // number, not string
        ),
      "OUTPUT_SCHEMA_MISMATCH",
      /result/,
    );
  });

  it("accepts the canonical-fixed { result: string } output shape", async () => {
    const node = agentNode();
    const state = makeState(node);
    const result = await executeAgentNode(
      node,
      state,
      makeDeps({ kind: "ok", output: { result: "hello world" } }),
    );
    expect(result).toEqual({ result: "hello world" });
  });
});
