/**
 * W2 — `runAgent` bridge tests.
 *
 * The bridge lives inside `execute-workflow.ts` as a closure
 * (`buildRealRunAgent`), so we test it through the public
 * `executeWorkflow` entry point with all collaborators mocked. The
 * key contracts:
 *
 *   - When `forceFresh` is omitted, agent nodes hit the GET-path
 *     stub (`stubRunAgent`) and throw AGENT_EXECUTION_FAILED with
 *     the "passive view" message. `runner.start` is never called.
 *   - When `forceFresh: true`, agent nodes dispatch through
 *     `runner.start({mode: "sync", ...})` with the workflow's
 *     entity_run id as `parentRunId`, owner threading, and the
 *     extracted `task` string.
 *   - A `succeeded` runner result wraps `summary` as
 *     `{ text: summary }` (D30 default schema).
 *   - Non-"succeeded" status and runner throws both surface as
 *     AGENT_EXECUTION_FAILED.
 *   - `extractTaskString` prefers `input.text`, falls back to JSON
 *     of non-empty objects, and emits a placeholder for `{}`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  EntityRunTable: {},
  EntityRunEventTable: {},
}));

// ─── Mocks for direct collaborators ────────────────────────────────────

const buildUserToolCatalog = vi.fn(async () => new Map());
vi.mock("@/lib/builtin-tools/build-user-catalog", () => ({
  buildUserToolCatalog: () => buildUserToolCatalog(),
}));

const getActiveAdapter = vi.fn(async () => ({
  run: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 0,
  })),
}));
vi.mock("@/lib/sandbox/registry.server", () => ({
  getActiveAdapter: () => getActiveAdapter(),
}));

const runnerStart = vi.fn();
vi.mock("@/lib/runner", () => ({
  runner: { start: (...args: unknown[]) => runnerStart(...args) },
}));

const recorderEmit = vi.fn();
const recorderSucceed = vi.fn(async () => {});
const recorderFail = vi.fn(async () => {});
const startRecording = vi.fn();
vi.mock("@/lib/artifacts/workflow-run-recorder", () => ({
  startRecording: (...args: unknown[]) => startRecording(...args),
}));

// Capture the deps passed to engine.execute so we can poke at its
// `runAgent` directly — that's the unit under test.
const engineExecute = vi.fn();
vi.mock("@/lib/workflows/engine/in-process", () => ({
  inProcessWorkflowEngine: {
    execute: (...args: unknown[]) => engineExecute(...args),
  },
}));

// ─── Imports after mocks ───────────────────────────────────────────────

import { executeWorkflow } from "@/lib/artifacts/execute-workflow";
import { WorkflowError } from "@/lib/workflows/error";
import type {
  AgentRunRequest,
  WorkflowEngineDependencies,
} from "@/lib/workflows/engine";
import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

// ─── Fixtures + helpers ────────────────────────────────────────────────

const baseSpec: CanonicalWorkflowSpec = {
  version: "1.0",
  name: "test-spec",
  nodes: [],
  outputs: { result: "@nodes.0.text" },
  refReconAlgorithm: "ref_recon_v1",
};

const agentReq: AgentRunRequest = {
  agentId: "agent-uuid",
  input: { text: "summarise sales for Q4" },
  outputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  abortSignal: new AbortController().signal,
  parentRunId: "workflow-run-1",
  excludeFrontendTools: true,
};

/**
 * Drive `executeWorkflow` end-to-end with engine.execute mocked to
 * call `runAgent` on the given input. Returns the runAgent return
 * value plus the deps the engine actually received — equivalent to
 * a single agent-node workflow having run to completion.
 */
async function runAgentNodeOnce(args: {
  forceFresh?: boolean;
  agentReq?: AgentRunRequest;
}): Promise<{
  runAgentResult: unknown;
  capturedDeps: WorkflowEngineDependencies;
}> {
  let captured: WorkflowEngineDependencies | undefined;
  let runAgentResult: unknown;
  engineExecute.mockImplementationOnce(
    async (_params: unknown, deps: WorkflowEngineDependencies) => {
      captured = deps;
      runAgentResult = await deps.runAgent(args.agentReq ?? agentReq);
      return { runId: "x", output: { result: "ok" }, nodeOutputs: {} };
    },
  );

  await executeWorkflow({
    workflowId: "wf-1",
    spec: baseSpec,
    outputField: "result",
    ownerId: "owner-1",
    ...(args.forceFresh !== undefined && { forceFresh: args.forceFresh }),
  });

  return { runAgentResult, capturedDeps: captured! };
}

beforeEach(() => {
  buildUserToolCatalog.mockReset();
  buildUserToolCatalog.mockResolvedValue(new Map());
  runnerStart.mockReset();
  startRecording.mockReset();
  recorderEmit.mockReset();
  recorderSucceed.mockReset();
  recorderFail.mockReset();
  engineExecute.mockReset();
});

// ─── GET path: stub fires ──────────────────────────────────────────────

describe("runAgent on the GET path (forceFresh not set)", () => {
  it("never calls runner.start and throws AGENT_EXECUTION_FAILED", async () => {
    let capturedRunAgent:
      | WorkflowEngineDependencies["runAgent"]
      | undefined;
    engineExecute.mockImplementationOnce(
      async (_params: unknown, deps: WorkflowEngineDependencies) => {
        capturedRunAgent = deps.runAgent;
        return { runId: "x", output: { result: "ok" }, nodeOutputs: {} };
      },
    );

    await executeWorkflow({
      workflowId: "wf-1",
      spec: baseSpec,
      outputField: "result",
      ownerId: "owner-1",
    });

    expect(startRecording).not.toHaveBeenCalled();
    // Force the captured runAgent to fire — should reject with the
    // GET-path message.
    await expect(capturedRunAgent!(agentReq)).rejects.toMatchObject({
      errorCode: "AGENT_EXECUTION_FAILED",
      message: expect.stringContaining("GET requests"),
    });
    expect(runnerStart).not.toHaveBeenCalled();
  });
});

// ─── Refresh path: real runner ────────────────────────────────────────

describe("runAgent on the refresh path (forceFresh: true)", () => {
  beforeEach(() => {
    startRecording.mockResolvedValue({
      runId: "workflow-run-1",
      emit: recorderEmit,
      succeed: recorderSucceed,
      fail: recorderFail,
    });
  });

  it("dispatches via runner.start with the engine-supplied parentRunId", async () => {
    runnerStart.mockResolvedValue({
      runId: "sub-run-1",
      status: "succeeded",
      summary: "Q4 sales summary text",
    });

    await runAgentNodeOnce({ forceFresh: true });

    expect(runnerStart).toHaveBeenCalledExactlyOnceWith({
      entityId: "agent-uuid",
      task: "summarise sales for Q4",
      context: agentReq.input,
      mode: "sync",
      initiator: "user",
      ownerId: "owner-1",
      createdBy: "owner-1",
      parentRunId: "workflow-run-1",
    });
  });

  it("wraps a successful runner result as { text: summary } per D30", async () => {
    runnerStart.mockResolvedValue({
      runId: "sub-run-2",
      status: "succeeded",
      summary: "Q4 sales summary text",
    });

    let capturedResult: unknown;
    engineExecute.mockImplementationOnce(
      async (_params: unknown, deps: WorkflowEngineDependencies) => {
        capturedResult = await deps.runAgent(agentReq);
        return { runId: "x", output: { result: "ok" }, nodeOutputs: {} };
      },
    );

    await executeWorkflow({
      workflowId: "wf-1",
      spec: baseSpec,
      outputField: "result",
      ownerId: "owner-1",
      forceFresh: true,
    });

    expect(capturedResult).toEqual({
      output: { text: "Q4 sales summary text" },
      childRunId: "sub-run-2",
    });
  });

  it("surfaces a non-succeeded runner result as AGENT_EXECUTION_FAILED", async () => {
    runnerStart.mockResolvedValue({
      runId: "sub-run-3",
      status: "failed",
      summary: "",
      errorMessage: "model returned 4xx",
    });

    let capturedRunAgent:
      | WorkflowEngineDependencies["runAgent"]
      | undefined;
    engineExecute.mockImplementationOnce(
      async (_params: unknown, deps: WorkflowEngineDependencies) => {
        capturedRunAgent = deps.runAgent;
        return { runId: "x", output: { result: "ok" }, nodeOutputs: {} };
      },
    );

    await executeWorkflow({
      workflowId: "wf-1",
      spec: baseSpec,
      outputField: "result",
      ownerId: "owner-1",
      forceFresh: true,
    });

    await expect(capturedRunAgent!(agentReq)).rejects.toMatchObject({
      errorCode: "AGENT_EXECUTION_FAILED",
      message: "model returned 4xx",
    });
  });

  it("wraps a runner.start throw as AGENT_EXECUTION_FAILED with cause", async () => {
    const recursionErr = Object.assign(new Error("Run recursion depth exceeded (4 > 3)"), {
      name: "RecursionDepthExceeded",
    });
    runnerStart.mockRejectedValue(recursionErr);

    let capturedRunAgent:
      | WorkflowEngineDependencies["runAgent"]
      | undefined;
    engineExecute.mockImplementationOnce(
      async (_params: unknown, deps: WorkflowEngineDependencies) => {
        capturedRunAgent = deps.runAgent;
        return { runId: "x", output: { result: "ok" }, nodeOutputs: {} };
      },
    );

    await executeWorkflow({
      workflowId: "wf-1",
      spec: baseSpec,
      outputField: "result",
      ownerId: "owner-1",
      forceFresh: true,
    });

    const caught = await capturedRunAgent!(agentReq).catch(
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(WorkflowError);
    const we = caught as WorkflowError;
    expect(we.errorCode).toBe("AGENT_EXECUTION_FAILED");
    expect(we.message).toContain("recursion depth exceeded");
    expect(we.cause).toBe(recursionErr);
  });

  it("falls back to a default status message when runner has no errorMessage", async () => {
    runnerStart.mockResolvedValue({
      runId: "sub-run-4",
      status: "cancelled",
      summary: "",
    });

    let capturedRunAgent:
      | WorkflowEngineDependencies["runAgent"]
      | undefined;
    engineExecute.mockImplementationOnce(
      async (_params: unknown, deps: WorkflowEngineDependencies) => {
        capturedRunAgent = deps.runAgent;
        return { runId: "x", output: { result: "ok" }, nodeOutputs: {} };
      },
    );

    await executeWorkflow({
      workflowId: "wf-1",
      spec: baseSpec,
      outputField: "result",
      ownerId: "owner-1",
      forceFresh: true,
    });

    await expect(capturedRunAgent!(agentReq)).rejects.toMatchObject({
      errorCode: "AGENT_EXECUTION_FAILED",
      message: expect.stringContaining("cancelled"),
    });
  });
});

// ─── extractTaskString behaviour via runAgent ─────────────────────────

describe("extractTaskString (probed via runner.start args)", () => {
  beforeEach(() => {
    startRecording.mockResolvedValue({
      runId: "workflow-run-1",
      emit: recorderEmit,
      succeed: recorderSucceed,
      fail: recorderFail,
    });
    runnerStart.mockResolvedValue({
      runId: "sub-run",
      status: "succeeded",
      summary: "ok",
    });
  });

  async function probeTask(input: Record<string, unknown>): Promise<string> {
    let capturedRunAgent:
      | WorkflowEngineDependencies["runAgent"]
      | undefined;
    engineExecute.mockImplementationOnce(
      async (_p: unknown, deps: WorkflowEngineDependencies) => {
        capturedRunAgent = deps.runAgent;
        return { runId: "x", output: { result: "ok" }, nodeOutputs: {} };
      },
    );
    await executeWorkflow({
      workflowId: "wf-1",
      spec: baseSpec,
      outputField: "result",
      ownerId: "owner-1",
      forceFresh: true,
    });
    await capturedRunAgent!({ ...agentReq, input });
    const call = (runnerStart as unknown as Mock).mock.calls.at(-1)!;
    return (call[0] as { task: string }).task;
  }

  it("prefers input.text when present and non-empty", async () => {
    expect(await probeTask({ text: "hello world" })).toBe("hello world");
  });

  it("JSON-serialises when text is absent", async () => {
    expect(await probeTask({ query: "select 1", limit: 10 })).toBe(
      JSON.stringify({ query: "select 1", limit: 10 }),
    );
  });

  it("emits a placeholder for an empty input object", async () => {
    expect(await probeTask({})).toBe("(empty workflow agent input)");
  });

  it("ignores text=\"\" and falls back to JSON", async () => {
    expect(await probeTask({ text: "" })).toBe(JSON.stringify({ text: "" }));
  });

  it("ignores non-string text and falls back to JSON", async () => {
    expect(await probeTask({ text: 42 })).toBe(JSON.stringify({ text: 42 }));
  });
});
