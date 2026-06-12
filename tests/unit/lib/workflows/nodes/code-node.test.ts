/**
 * Unit tests for the code-node executor (D35).
 *
 * Mirrors the per-attempt body documented in
 * `src/lib/workflows/nodes/code-node.ts`:
 *
 *   1. Refs in `node.inputs` resolve before `runCode` is called.
 *   2. `inputs.datasets` is coerced to `string[]` and passed through.
 *   3. `inputs.env` is coerced to `Record<string, string>`.
 *   4. exitCode === 0 → outputs = fixed CodeOutputEnvelope.
 *   5. exitCode !== 0 → CODE_EXECUTION_FAILED with stderr surfaced.
 *   6. Defensive coercion errors → SPEC_SCHEMA_MISMATCH at the node.
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
  overrides?: Partial<Omit<CanonicalCodeNode, "type" | "inputs">> & {
    inputs?: Partial<CanonicalCodeNode["inputs"]>;
  },
): CanonicalCodeNode {
  const { inputs: inputsOverride, ...rest } = overrides ?? {};
  return {
    type: "code",
    schema_version: "1",
    id: 0,
    description: "n",
    depends_on: [],
    ...rest,
    inputs: {
      language: inputsOverride?.language ?? "python",
      ...(inputsOverride?.code_text !== undefined && {
        code_text: inputsOverride.code_text,
      }),
      ...(inputsOverride?.code_file !== undefined && {
        code_file: inputsOverride.code_file,
      }),
      ...(inputsOverride?.datasets !== undefined && {
        datasets: inputsOverride.datasets,
      }),
      ...(inputsOverride?.params !== undefined && {
        params: inputsOverride.params,
      }),
      // Default to code_text only when the override doesn't supply
      // either source. The XOR invariant lives in validate.ts.
      ...(inputsOverride?.code_text === undefined &&
        inputsOverride?.code_file === undefined && {
          code_text: "print('hi')",
        }),
    },
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
    name: "demo",
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
    // stdout "hello\n" is not valid JSON → assembleCodeOutput uses it as
    // the message fallback; all data fields are null.
    expect(out).toEqual({
      ok: true,
      duration_ms: 12,
      rows: null,
      row_count: null,
      row_schema: null,
      message: "hello\n",
      files: null,
      error: null,
    });
  });

  it("forwards language + code + datasets to runCode", async () => {
    const node = codeNode({
      inputs: {
        language: "python",
        code_text: "print(1+1)",
        datasets: ["ds_orders_q4"],
      },
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
      inputs: { datasets: ["@nodes.1.name"] },
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

  it("serializes params as __PARAMS__ JSON env var (preserves number type)", async () => {
    const node = codeNode({
      inputs: {
        params: { THRESHOLD: "@nodes.1.value", LABEL: "static" },
      },
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
    // Params are serialized as a single JSON string under __PARAMS__,
    // preserving type fidelity (0.5 stays a number, not "0.5").
    expect(deps.calls[0]!.env).toEqual({
      __PARAMS__: JSON.stringify({ THRESHOLD: 0.5, LABEL: "static" }),
    });
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
    const node = codeNode({ timeout_seconds: 90 });
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

// ─── code_file mode ────────────────────────────────────────────────────

describe("executeCodeNode — code_file mode", () => {
  it("passes codeFile (not code) to runCode when inputs.code_file is set", async () => {
    const node = codeNode({ inputs: { code_file: "analysis.py" } });
    const deps = makeDeps({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      durationMs: 3,
    });
    await executeCodeNode(node, makeState(node), deps);
    const req = deps.calls[0]!;
    expect(req.codeFile).toBe("analysis.py");
    expect(req.code).toBeUndefined();
  });

  it("forwards datasets alongside codeFile", async () => {
    const node = codeNode({
      inputs: { code_file: "main.py", datasets: ["orders_q4"] },
    });
    const deps = makeDeps({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      durationMs: 2,
    });
    await executeCodeNode(node, makeState(node), deps);
    expect(deps.calls[0]!.datasets).toEqual(["orders_q4"]);
  });

  it("throws SPEC_SCHEMA_MISMATCH for absolute code_file path", async () => {
    const node = codeNode({ inputs: { code_file: "/etc/passwd" } });
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
    });
    await expect(
      executeCodeNode(node, makeState(node), deps),
    ).rejects.toMatchObject({ errorCode: "SPEC_SCHEMA_MISMATCH" });
    expect(deps.calls).toHaveLength(0); // runCode must not be reached
  });

  it("throws SPEC_SCHEMA_MISMATCH for path-traversal code_file", async () => {
    const node = codeNode({ inputs: { code_file: "../../etc/passwd" } });
    const deps = makeDeps({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
    });
    await expect(
      executeCodeNode(node, makeState(node), deps),
    ).rejects.toMatchObject({ errorCode: "SPEC_SCHEMA_MISMATCH" });
    expect(deps.calls).toHaveLength(0);
  });

  it("accepts a subdir/file.py path (no traversal)", async () => {
    const node = codeNode({ inputs: { code_file: "subdir/main.py" } });
    const deps = makeDeps({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    });
    await expect(
      executeCodeNode(node, makeState(node), deps),
    ).resolves.toBeDefined();
    expect(deps.calls[0]!.codeFile).toBe("subdir/main.py");
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
      // Error text comes from envelope.error (= stderr trim), not a formatted
      // "exit_code=N" prefix — assembleCodeOutput surfaces the raw stderr.
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
      // When stderr is empty, assembleCodeOutput falls back to the text
      // "Process exited with code <N>" — no "exit_code=N" token.
      expect(e.message).toContain("Process exited with code 137");
    }
  });

  it("SPEC_SCHEMA_MISMATCH when input.datasets isn't an array", async () => {
    const node = codeNode({
      inputs: { datasets: "not-an-array" as unknown as unknown[] },
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
      inputs: { datasets: ["ok", 42] },
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
      retries: { attempts: 0, delay_seconds: 0 },
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
