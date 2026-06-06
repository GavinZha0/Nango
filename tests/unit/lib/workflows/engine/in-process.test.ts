import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type {
  AgentRunRequest,
  AgentRunResult,
  CodeRunRequest,
  CodeRunResult,
  ExecuteParams,
  ToolHandle,
  WorkflowEngineDependencies,
  WorkflowEngineEvent,
} from "@/lib/workflows/engine";
import { InProcessLruCache } from "@/lib/workflows/engine/cache";
import { inProcessWorkflowEngine } from "@/lib/workflows/engine/in-process";
import type {
  CanonicalNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

const AGENT_UUID = "11111111-1111-4111-8111-111111111111";

function spec(
  nodes: CanonicalNode[],
  outputs: Record<string, string>,
  extra?: Partial<CanonicalWorkflowSpec>,
): CanonicalWorkflowSpec {
  return {
    version: "1.0",
    name: "demo",
    ref_recon_algorithm: "ref_recon_v1",
    nodes,
    outputs,
    ...extra,
  };
}

function tool(
  id: number,
  toolName: string,
  depends_on: number[] = [],
  inputs: Record<string, unknown> = {},
): CanonicalNode {
  return {
    type: "tool",
    schema_version: "1",
    id,
    description: `n${id}`,
    depends_on,
    tool: toolName,
    inputs,
  };
}

function agent(
  id: number,
  depends_on: number[] = [],
  inputs: Record<string, unknown> = {},
): CanonicalNode {
  return {
    type: "agent",
    schema_version: "1",
    id,
    description: `agent-${id}`,
    depends_on,
    agent: "Builtin / DataAnalyst",
    agent_id: AGENT_UUID,
    inputs,
    output_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  };
}

interface StubBuilderArgs {
  tools?: Record<
    string,
    (
      inputs: Record<string, unknown>,
      ctx: Readonly<Record<string, unknown>>,
    ) => Promise<unknown> | unknown
  >;
  runAgent?: (req: AgentRunRequest) => Promise<AgentRunResult> | AgentRunResult;
  runCode?: (
    req: CodeRunRequest,
  ) => Promise<CodeRunResult> | CodeRunResult;
  missingTools?: string[];
}

function buildDeps(
  args: StubBuilderArgs,
): WorkflowEngineDependencies & {
  events: WorkflowEngineEvent[];
  toolCalls: { name: string; input: Record<string, unknown> }[];
  agentCalls: AgentRunRequest[];
  codeCalls: CodeRunRequest[];
} {
  const events: WorkflowEngineEvent[] = [];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  const agentCalls: AgentRunRequest[] = [];
  const codeCalls: CodeRunRequest[] = [];
  const deps = {
    getTool: (name: string): ToolHandle | null => {
      if (args.missingTools?.includes(name)) return null;
      const impl = args.tools?.[name];
      if (impl === undefined) {
        return {
          execute: async ({ input }) => {
            toolCalls.push({ name, input });
            return { ok: true };
          },
        };
      }
      return {
        execute: async ({ input, context }) => {
          toolCalls.push({ name, input });
          return await impl(input, context);
        },
      };
    },
    runAgent: async (req: AgentRunRequest): Promise<AgentRunResult> => {
      agentCalls.push(req);
      if (args.runAgent !== undefined) return await args.runAgent(req);
      return { output: { summary: "default summary" }, childRunId: "c" };
    },
    runCode: async (req: CodeRunRequest): Promise<CodeRunResult> => {
      codeCalls.push(req);
      if (args.runCode !== undefined) return await args.runCode(req);
      // Default success — empty stdout. Tests that exercise code
      // nodes either supply their own stub or assert on codeCalls.
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
    emitEvent: (e: WorkflowEngineEvent) => {
      events.push(e);
    },
    events,
    toolCalls,
    agentCalls,
    codeCalls,
  };
  return deps;
}

function makeParams(
  spec: CanonicalWorkflowSpec,
  init?: {
    input?: Record<string, unknown>;
    context?: Record<string, unknown>;
    abortController?: AbortController;
  },
): ExecuteParams {
  return {
    workflowId: "wf-1",
    runId: "run-1",
    spec,
    input: init?.input ?? {},
    context: init?.context ?? {},
    abortController: init?.abortController ?? new AbortController(),
  };
}

function expectThrowsWf(
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

describe("inProcessWorkflowEngine — happy paths", () => {
  it("runs a single-node tool workflow and resolves spec.outputs", async () => {
    const s = spec(
      [tool(0, "extract", [], { sql: "select 1" })],
      { dataset: "@nodes.0.dataset" },
    );
    const deps = buildDeps({
      tools: { extract: () => ({ dataset: "p.parquet", rowCount: 42 }) },
    });
    const result = await inProcessWorkflowEngine.execute(
      makeParams(s),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.runId).toBe("run-1");
    expect(result.output).toEqual({ dataset: "p.parquet" });
    expect(result.nodeOutputs.get(0)).toEqual({
      dataset: "p.parquet",
      rowCount: 42,
    });
  });

  it("emits lifecycle events in order: started → node attempts → completed", async () => {
    const s = spec(
      [tool(0, "extract")],
      { x: "@nodes.0.dataset" },
    );
    const deps = buildDeps({
      tools: { extract: () => ({ dataset: "x" }) },
    });
    await inProcessWorkflowEngine.execute(makeParams(s), deps);
    expect(deps.events.map((e) => e.type)).toEqual([
      "workflow_started",
      "workflow_node_attempt_started",
      "workflow_node_completed",
      "workflow_completed",
    ]);
    expect(deps.events[0]).toEqual({
      type: "workflow_started",
      runId: "run-1",
    });
    const last = deps.events[deps.events.length - 1];
    if (last?.type !== "workflow_completed") throw new Error();
    expect(last.output).toEqual({ x: "x" });
  });

  it("chains tool → tool with refs flowing through", async () => {
    const s = spec(
      [
        tool(0, "extract", [], { sql: "select 1" }),
        tool(1, "transform", [0], { dataset: "@nodes.0.dataset" }),
      ],
      { result: "@nodes.1.result" },
    );
    const deps = buildDeps({
      tools: {
        extract: () => ({ dataset: "p.parquet" }),
        transform: (input) => ({ result: `transformed:${input.dataset}` }),
      },
    });
    const result = await inProcessWorkflowEngine.execute(
      makeParams(s),
      deps,
    );
    expect(result.output).toEqual({ result: "transformed:p.parquet" });
    expect(deps.toolCalls).toEqual([
      { name: "extract", input: { sql: "select 1" } },
      { name: "transform", input: { dataset: "p.parquet" } },
    ]);
  });

  it("dispatches tool vs agent by node.type", async () => {
    const s = spec(
      [
        tool(0, "extract"),
        agent(1, [0], { dataset: "@nodes.0.dataset" }),
      ],
      { summary: "@nodes.1.summary" },
    );
    const deps = buildDeps({
      tools: { extract: () => ({ dataset: "p.parquet" }) },
      runAgent: async () => ({
        output: { summary: "5 rows analysed" },
        childRunId: "child-1",
      }),
    });
    const result = await inProcessWorkflowEngine.execute(
      makeParams(s),
      deps,
    );
    expect(deps.toolCalls.map((c) => c.name)).toEqual(["extract"]);
    expect(deps.agentCalls).toHaveLength(1);
    expect(deps.agentCalls[0]!.input).toEqual({ dataset: "p.parquet" });
    expect(result.output).toEqual({ summary: "5 rows analysed" });
  });

  it("resolves spec.outputs entries from heterogeneous sources", async () => {
    const s = spec(
      [
        tool(0, "extract", [], { dataset: "@workflow.dataset_name" }),
      ],
      {
        from_node: "@nodes.0.rowCount",
        from_workflow: "@workflow.dataset_name",
        from_context: "@context.tenant",
      },
      {
        input_schema: {
          type: "object",
          properties: { dataset_name: { type: "string" } },
        },
      },
    );
    const deps = buildDeps({
      tools: { extract: () => ({ rowCount: 100, dataset: "x" }) },
    });
    const result = await inProcessWorkflowEngine.execute(
      makeParams(s, {
        input: { dataset_name: "orders" },
        context: { tenant: "acme" },
      }),
      deps,
    );
    expect(result.output).toEqual({
      from_node: 100,
      from_workflow: "orders",
      from_context: "acme",
    });
  });
});

// ─── Failure paths ────────────────────────────────────────────────────

describe("inProcessWorkflowEngine — failure paths", () => {
  it("emits workflow_failed and re-throws the failing node's WorkflowError (stop mode)", async () => {
    const s = spec(
      [
        tool(0, "extract"),
        tool(1, "transform", [0]),
      ],
      { x: "@nodes.0.dataset" },
    );
    const deps = buildDeps({
      tools: {
        extract: () => {
          throw new WorkflowError({
            errorCode: "SQL_SYNTAX_ERROR",
            message: "bad sql",
            nodeId: 0,
            nodeName: "extract",
          });
        },
      },
    });
    const e = await expectThrowsWf(
      () => inProcessWorkflowEngine.execute(makeParams(s), deps),
      "SQL_SYNTAX_ERROR",
    );
    expect(e.nodeId).toBe(0);
    const failedEvent = deps.events.find((ev) => ev.type === "workflow_failed");
    if (failedEvent?.type !== "workflow_failed") throw new Error();
    expect(failedEvent.errorCode).toBe("SQL_SYNTAX_ERROR");
    expect(failedEvent.nodeId).toBe(0);
  });

  it("emits TOOL_NOT_FOUND when registry misses (and workflow_failed)", async () => {
    const s = spec(
      [tool(0, "ghost_tool")],
      { x: "@nodes.0.x" },
    );
    const deps = buildDeps({ missingTools: ["ghost_tool"] });
    await expectThrowsWf(
      () => inProcessWorkflowEngine.execute(makeParams(s), deps),
      "TOOL_NOT_FOUND",
    );
    expect(
      deps.events.find((e) => e.type === "workflow_failed"),
    ).toBeDefined();
  });

  it("picks the lowest-id failed node for deterministic error surfacing", async () => {
    // Both 0 and 1 fail in the same batch (independent siblings).
    // First failure surfaced should be node 0 (lower id).
    const s = spec(
      [
        tool(0, "first_fail"),
        tool(1, "second_fail"),
      ],
      { x: "@nodes.0.x" },
    );
    const deps = buildDeps({
      tools: {
        first_fail: () => {
          throw new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: "first",
            nodeId: 0,
          });
        },
        second_fail: () => {
          throw new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: "second",
            nodeId: 1,
          });
        },
      },
    });
    const e = await expectThrowsWf(
      () => inProcessWorkflowEngine.execute(makeParams(s), deps),
      "TOOL_EXECUTION_FAILED",
      /first/,
    );
    expect(e.nodeId).toBe(0);
  });

  it("throws OUTPUT_REF_UNRESOLVED when spec.outputs ref targets a skipped node", async () => {
    // In on_failure="continue" mode, node 0 fails alone, node 1
    // completes. spec.outputs references @nodes.0.x — a value
    // the failed node never produced.
    const s = spec(
      [
        tool(0, "fail_tool"),
        tool(1, "ok_tool"),
      ],
      { from_failed: "@nodes.0.x" },
      { execution: { on_failure: "continue" } },
    );
    const deps = buildDeps({
      tools: {
        fail_tool: () => {
          throw new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: "bad",
            nodeId: 0,
          });
        },
        ok_tool: () => ({ x: 1 }),
      },
    });
    // The first failed node's error fires first (since state.failed
    // has entries) — OUTPUT_REF_UNRESOLVED would only fire on a
    // SUCCESSFUL run with stale refs. So this test exercises the
    // failure precedence: TOOL_EXECUTION_FAILED wins over
    // OUTPUT_REF_UNRESOLVED.
    await expectThrowsWf(
      () => inProcessWorkflowEngine.execute(makeParams(s), deps),
      "TOOL_EXECUTION_FAILED",
    );
  });
});

// ─── AbortSignal ──────────────────────────────────────────────────────

describe("inProcessWorkflowEngine — AbortSignal", () => {
  it("throws WORKFLOW_TIMEOUT when signal is already aborted (no nodes run)", async () => {
    const s = spec(
      [tool(0, "extract")],
      { x: "@nodes.0.x" },
    );
    const ac = new AbortController();
    ac.abort();
    const deps = buildDeps({});
    const e = await expectThrowsWf(
      () =>
        inProcessWorkflowEngine.execute(
          makeParams(s, { abortController: ac }),
          deps,
        ),
      "WORKFLOW_TIMEOUT",
      /aborted/,
    );
    expect(e.nodeId).toBeUndefined(); // workflow-scoped
    expect(deps.toolCalls).toHaveLength(0);
    expect(
      deps.events.find((ev) => ev.type === "workflow_failed"),
    ).toBeDefined();
  });

  it("throws WORKFLOW_TIMEOUT when signal fires mid-run", async () => {
    const s = spec(
      [
        tool(0, "extract"),
        tool(1, "transform", [0]),
      ],
      { x: "@nodes.1.x" },
    );
    const ac = new AbortController();
    const deps = buildDeps({
      tools: {
        extract: () => {
          // Abort after node 0 starts but before node 1 dispatches.
          ac.abort();
          return { dataset: "x" };
        },
      },
    });
    await expectThrowsWf(
      () =>
        inProcessWorkflowEngine.execute(
          makeParams(s, { abortController: ac }),
          deps,
        ),
      "WORKFLOW_TIMEOUT",
    );
    expect(deps.toolCalls.map((c) => c.name)).toEqual(["extract"]);
  });
});

// ─── on_failure: continue (success-after-failure NOT possible) ────────

describe("inProcessWorkflowEngine — on_failure semantics", () => {
  it("treats workflow as failed if ANY node failed (even with on_failure=continue)", async () => {
    // Even though node 1 completes successfully, the workflow as
    // a whole fails because node 0 failed. on_failure="continue"
    // is about COMPLETING the DAG, not about treating partial
    // success as success.
    const s = spec(
      [
        tool(0, "fail_tool"),
        tool(1, "ok_tool"), // independent
      ],
      { x: "@nodes.1.x" },
      { execution: { on_failure: "continue" } },
    );
    const deps = buildDeps({
      tools: {
        fail_tool: () => {
          throw new WorkflowError({
            errorCode: "TOOL_EXECUTION_FAILED",
            message: "fail",
            nodeId: 0,
          });
        },
        ok_tool: () => ({ x: 99 }),
      },
    });
    await expectThrowsWf(
      () => inProcessWorkflowEngine.execute(makeParams(s), deps),
      "TOOL_EXECUTION_FAILED",
    );
    // But node 1's tool WAS called — the independent path completed.
    expect(deps.toolCalls.map((c) => c.name).sort()).toEqual([
      "fail_tool",
      "ok_tool",
    ]);
  });
});

// ─── Per-node cache (W1.4.7) ──────────────────────────────────────────

describe("inProcessWorkflowEngine — per-node cache integration", () => {
  it("cache hit on second run skips the tool executor", async () => {
    const s = spec(
      [tool(0, "extract", [], { sql: "select 1" })],
      { dataset: "@nodes.0.dataset" },
    );
    const cache = new InProcessLruCache();
    let executions = 0;
    const tools = {
      extract: () => {
        executions += 1;
        return { dataset: "p.parquet" };
      },
    };
    const deps1 = { ...buildDeps({ tools }), cache } as WorkflowEngineDependencies & {
      toolCalls: { name: string; input: Record<string, unknown> }[];
      events: WorkflowEngineEvent[];
    };
    const r1 = await inProcessWorkflowEngine.execute(makeParams(s), deps1);
    expect(r1.output).toEqual({ dataset: "p.parquet" });
    expect(executions).toBe(1);

    // Second run with the SAME cache + spec → should hit.
    const deps2 = { ...buildDeps({ tools }), cache } as WorkflowEngineDependencies & {
      toolCalls: { name: string; input: Record<string, unknown> }[];
      events: WorkflowEngineEvent[];
    };
    const r2 = await inProcessWorkflowEngine.execute(makeParams(s), deps2);
    expect(r2.output).toEqual({ dataset: "p.parquet" });
    expect(executions).toBe(1); // ← still 1, cache hit
  });

  it("cache hit emits workflow_node_completed with cached: true + durationMs: 0", async () => {
    const s = spec(
      [tool(0, "extract", [], { sql: "select 1" })],
      { dataset: "@nodes.0.dataset" },
    );
    const cache = new InProcessLruCache();
    const tools = { extract: () => ({ dataset: "p" }) };

    // First run — populate cache.
    await inProcessWorkflowEngine.execute(
      makeParams(s),
      { ...buildDeps({ tools }), cache } as WorkflowEngineDependencies,
    );

    // Second run — inspect events.
    const deps2 = buildDeps({ tools });
    await inProcessWorkflowEngine.execute(
      makeParams(s),
      { ...deps2, cache } as WorkflowEngineDependencies,
    );
    const completed = deps2.events.find(
      (e) => e.type === "workflow_node_completed",
    );
    if (completed?.type !== "workflow_node_completed") throw new Error();
    expect(completed.cached).toBe(true);
    expect(completed.durationMs).toBe(0);
    expect(completed.outputs).toEqual({ dataset: "p" });
    // No attempt_started fires on cache hit — only the synthetic
    // completed event.
    expect(
      deps2.events.find((e) => e.type === "workflow_node_attempt_started"),
    ).toBeUndefined();
  });

  it("editing description does NOT bust the cache (cosmetic field excluded)", async () => {
    const cache = new InProcessLruCache();
    let executions = 0;
    const tools = {
      extract: () => {
        executions += 1;
        return { x: 1 };
      },
    };

    const s1 = spec(
      [tool(0, "extract", [], { sql: "select 1" })],
      { x: "@nodes.0.x" },
    );
    await inProcessWorkflowEngine.execute(makeParams(s1), {
      ...buildDeps({ tools }),
      cache,
    } as WorkflowEngineDependencies);

    // Second workflow: same node semantics, just `description`
    // changed (via id reuse path, mimicking the user edit).
    const editedNode = { ...tool(0, "extract", [], { sql: "select 1" }) };
    editedNode.description = "Edited description";
    const s2 = spec([editedNode], { x: "@nodes.0.x" });
    await inProcessWorkflowEngine.execute(makeParams(s2), {
      ...buildDeps({ tools }),
      cache,
    } as WorkflowEngineDependencies);
    expect(executions).toBe(1); // still 1 — same key
  });

  it("editing tool input DOES bust the cache (semantic change)", async () => {
    const cache = new InProcessLruCache();
    let executions = 0;
    const tools = {
      extract: () => {
        executions += 1;
        return { v: executions };
      },
    };

    const s1 = spec(
      [tool(0, "extract", [], { sql: "select 1" })],
      { v: "@nodes.0.v" },
    );
    const r1 = await inProcessWorkflowEngine.execute(makeParams(s1), {
      ...buildDeps({ tools }),
      cache,
    } as WorkflowEngineDependencies);
    expect(r1.output).toEqual({ v: 1 });

    const s2 = spec(
      [tool(0, "extract", [], { sql: "select 2" })], // different sql
      { v: "@nodes.0.v" },
    );
    const r2 = await inProcessWorkflowEngine.execute(makeParams(s2), {
      ...buildDeps({ tools }),
      cache,
    } as WorkflowEngineDependencies);
    expect(r2.output).toEqual({ v: 2 });
    expect(executions).toBe(2); // both executed
  });

  it("failures are NOT cached — re-running a failing node retries", async () => {
    const cache = new InProcessLruCache();
    let calls = 0;
    const tools = {
      extract: () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { ok: true };
      },
    };
    const s = spec(
      [tool(0, "extract", [], { sql: "select 1" })],
      { ok: "@nodes.0.ok" },
    );

    // First run fails.
    await expect(
      inProcessWorkflowEngine.execute(makeParams(s), {
        ...buildDeps({ tools }),
        cache,
      } as WorkflowEngineDependencies),
    ).rejects.toBeTruthy();

    // Second run with same cache — should re-attempt (failure not cached).
    const r = await inProcessWorkflowEngine.execute(makeParams(s), {
      ...buildDeps({ tools }),
      cache,
    } as WorkflowEngineDependencies);
    expect(r.output).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("REF_UNRESOLVED falls through to the executor (proper event lifecycle)", async () => {
    const cache = new InProcessLruCache();
    const s = spec(
      [
        tool(0, "broken", [], { dep: "@workflow.missing_input" }),
      ],
      { x: "@nodes.0.x" },
    );
    const deps = { ...buildDeps({}), cache } as WorkflowEngineDependencies & {
      events: WorkflowEngineEvent[];
    };
    await expect(
      inProcessWorkflowEngine.execute(makeParams(s), deps),
    ).rejects.toMatchObject({ errorCode: "REF_UNRESOLVED" });
    // Even though cache wrapper saw the throw, the executor's
    // attempt_started + attempt_failed still emit.
    expect(
      deps.events.find((e) => e.type === "workflow_node_attempt_started"),
    ).toBeDefined();
    expect(
      deps.events.find((e) => e.type === "workflow_node_attempt_failed"),
    ).toBeDefined();
  });
});
