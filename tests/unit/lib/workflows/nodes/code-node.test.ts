/**
 * Unit tests for the code-node executor (D35).
 *
 * Mirrors the per-attempt body documented in
 * `src/lib/workflows/nodes/code-node.ts`:
 *
 *   1. Refs in `node.input` resolve before `runCode` is called.
 *   2. `inputs.datasets` is coerced to `string[]` and passed through.
 *   3. `inputs.env` is coerced to `Record<string, string>`.
 *   4. exitCode === 0 → outputs = either fixed envelope OR
 *      parsed-stdout per declared `output_schema`.
 *   5. exitCode !== 0 → CODE_EXECUTION_FAILED with stderr surfaced.
 *   6. Declared output_schema mismatches → OUTPUT_SCHEMA_MISMATCH.
 *   7. Defensive coercion errors → SPEC_SCHEMA_MISMATCH at the node.
 */

import { describe, expect, it } from "vitest";

import { WorkflowError } from "@/lib/workflows/error";
import type {
  CodeRunRequest,
  CodeRunResult,
  ExecuteParams,
  WorkflowEngineEvent,
} from "@/lib/workflows/engine";
import {
  createExecutionState,
  type ExecutionState,
} from "@/lib/workflows/engine/execution-context";
import {
  executeCodeNode,
  type CodeNodeDeps,
} from "@/lib/workflows/nodes/code-node";
import type {
  CanonicalCodeNode,
  CanonicalWorkflowSpec,
} from "@/lib/workflows/spec/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────

function codeNode(
  overrides?: Partial<Omit<CanonicalCodeNode, "type">>,
): CanonicalCodeNode {
  return {
    type: "code",
    id: 0,
    description: "n",
    depends_on: [],
    language: "python",
    code: "print('hi')",
    outputs: ["stdout", "stderr", "exitCode", "durationMs"],
    ...overrides,
  };
}

function makeState(
  node: CanonicalCodeNode,
  init?: {
    input?: Record<string, unknown>;
    outputs?: Map<number, Record<string, unknown>>;
  },
): ExecutionState {
  const spec: CanonicalWorkflowSpec = {
    version: "1.0",
    name: "demo",
    refReconAlgorithm: "ref_recon_v1",
    nodes: [node],
    outputs: { dummy: "@nodes.0.stdout" },
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
  result: CodeRunResult,
): CodeNodeDeps & { calls: CodeRunRequest[]; events: WorkflowEngineEvent[] } {
  const calls: CodeRunRequest[] = [];
  const events: WorkflowEngineEvent[] = [];
  return {
    runCode: async (req: CodeRunRequest) => {
      calls.push(req);
      return result;
    },
    emitEvent: (e: WorkflowEngineEvent) => {
      events.push(e);
    },
    calls,
    events,
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────

describe("executeCodeNode — success without declared schema", () => {
  it("returns the fixed envelope shape", async () => {
    const node = codeNode();
    const deps = makeDeps({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12,
    });
    const out = await executeCodeNode(node, makeState(node), deps);
    expect(out).toEqual({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12,
    });
  });

  it("forwards language + code + datasets to runCode", async () => {
    const node = codeNode({
      language: "python",
      code: "print(1+1)",
      input: { datasets: ["ds_orders_q4"] },
    });
    const deps = makeDeps({
      stdout: "2\n",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });
    await executeCodeNode(node, makeState(node), deps);
    expect(deps.calls).toHaveLength(1);
    const req = deps.calls[0]!;
    expect(req.language).toBe("python");
    expect(req.code).toBe("print(1+1)");
    expect(req.datasets).toEqual(["ds_orders_q4"]);
    expect(req.env).toEqual({});
  });

  it("resolves @nodes.X.Y refs inside input.datasets before runCode", async () => {
    const node = codeNode({
      depends_on: [1],
      input: { datasets: ["@nodes.1.name"] },
    });
    const state = makeState(node, {
      outputs: new Map([[1, { name: "resolved-dataset-name" }]]),
    });
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    await executeCodeNode(node, state, deps);
    expect(deps.calls[0]!.datasets).toEqual(["resolved-dataset-name"]);
  });

  it("coerces env values to strings (non-string refs get String()'d)", async () => {
    const node = codeNode({
      input: { env: { THRESHOLD: "@nodes.1.value", LABEL: "static" } },
      depends_on: [1],
    });
    const state = makeState(node, {
      outputs: new Map([[1, { value: 0.5 }]]),
    });
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    await executeCodeNode(node, state, deps);
    expect(deps.calls[0]!.env).toEqual({ THRESHOLD: "0.5", LABEL: "static" });
  });

  it("uses default timeout when node omits it", async () => {
    const node = codeNode();
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    await executeCodeNode(node, makeState(node), deps);
    expect(deps.calls[0]!.timeoutMs).toBe(30_000);
  });

  it("forwards per-node timeoutSeconds (in milliseconds)", async () => {
    const node = codeNode({ timeoutSeconds: 90 });
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    await executeCodeNode(node, makeState(node), deps);
    expect(deps.calls[0]!.timeoutMs).toBe(90_000);
  });
});

// ─── Success with declared schema ─────────────────────────────────────

describe("executeCodeNode — success with declared output_schema", () => {
  it("JSON.parses stdout + returns the parsed object as outputs", async () => {
    const node = codeNode({
      output_schema: {
        type: "object",
        properties: { mean: { type: "number" }, std: { type: "number" } },
        required: ["mean", "std"],
      },
      outputs: ["mean", "std"],
    });
    const deps = makeDeps({
      stdout: '{"mean": 5.0, "std": 1.2}',
      stderr: "",
      exitCode: 0,
      durationMs: 8,
    });
    const out = await executeCodeNode(node, makeState(node), deps);
    expect(out).toEqual({ mean: 5.0, std: 1.2 });
  });

  it("OUTPUT_SCHEMA_MISMATCH when stdout JSON fails schema", async () => {
    const node = codeNode({
      output_schema: {
        type: "object",
        properties: { mean: { type: "number" } },
        required: ["mean"],
      },
      outputs: ["mean"],
    });
    const deps = makeDeps({
      stdout: '{"mean": "not-a-number"}',
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    await expect(executeCodeNode(node, makeState(node), deps)).rejects.toThrow(
      WorkflowError,
    );
    try {
      await executeCodeNode(node, makeState(node), deps);
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("OUTPUT_SCHEMA_MISMATCH");
    }
  });

  it("OUTPUT_SCHEMA_MISMATCH when stdout isn't valid JSON", async () => {
    const node = codeNode({
      output_schema: { type: "object" },
      outputs: [],
    });
    const deps = makeDeps({
      stdout: "<<not json>>",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    try {
      await executeCodeNode(node, makeState(node), deps);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("OUTPUT_SCHEMA_MISMATCH");
      expect(e.message).toContain("not valid JSON");
    }
  });

  it("OUTPUT_SCHEMA_MISMATCH when stdout JSON is an array, not object", async () => {
    const node = codeNode({
      output_schema: { type: "object" },
      outputs: [],
    });
    const deps = makeDeps({
      stdout: "[1,2,3]",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    try {
      await executeCodeNode(node, makeState(node), deps);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("OUTPUT_SCHEMA_MISMATCH");
      expect(e.message).toContain("must be an object");
    }
  });
});

// ─── Failure paths ────────────────────────────────────────────────────

describe("executeCodeNode — process failures", () => {
  it("CODE_EXECUTION_FAILED when exitCode != 0, stderr surfaced", async () => {
    const node = codeNode();
    const deps = makeDeps({
      stdout: "",
      stderr:
        "Traceback (most recent call last):\n  File '<stdin>', line 1\nModuleNotFoundError: No module named 'duckdb'",
      exitCode: 1,
      durationMs: 62,
    });
    try {
      await executeCodeNode(node, makeState(node), deps);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("CODE_EXECUTION_FAILED");
      expect(e.message).toContain("exitCode=1");
      expect(e.message).toContain("ModuleNotFoundError");
      expect(e.nodeId).toBe(0);
    }
  });

  it("CODE_EXECUTION_FAILED on non-zero exit without stderr (still surfaces exitCode)", async () => {
    const node = codeNode();
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 137, // SIGKILL convention
      durationMs: 500,
    });
    try {
      await executeCodeNode(node, makeState(node), deps);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("CODE_EXECUTION_FAILED");
      expect(e.message).toContain("exitCode=137");
    }
  });

  it("SPEC_SCHEMA_MISMATCH when input.datasets isn't an array", async () => {
    const node = codeNode({
      input: { datasets: "not-an-array" as unknown as string[] },
    });
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    try {
      await executeCodeNode(node, makeState(node), deps);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("SPEC_SCHEMA_MISMATCH");
      expect(e.message).toContain("must be an array");
    }
  });

  it("SPEC_SCHEMA_MISMATCH when input.datasets contains non-strings", async () => {
    const node = codeNode({
      input: { datasets: ["ok", 42 as unknown as string] },
    });
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    try {
      await executeCodeNode(node, makeState(node), deps);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("SPEC_SCHEMA_MISMATCH");
      expect(e.message).toContain("datasets[1]");
    }
  });

  it("wraps non-WorkflowError throws as CODE_EXECUTION_FAILED", async () => {
    const node = codeNode({
      retries: { attempts: 0, delaySeconds: 0 },
    });
    const state = makeState(node);
    const deps: CodeNodeDeps = {
      runCode: async () => {
        throw new Error("sandbox adapter unavailable");
      },
      emitEvent: () => {},
    };
    try {
      await executeCodeNode(node, state, deps);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      expect(e.errorCode).toBe("CODE_EXECUTION_FAILED");
      expect(e.message).toContain("sandbox adapter unavailable");
    }
  });
});
