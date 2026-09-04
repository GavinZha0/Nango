import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockRunWebAutoMcp = vi.fn();
const mockRunWebAutoEvaluation = vi.fn();
const mockPublish = vi.fn();
const mockRecordRunNotification = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/web-auto/runner-mcp", () => ({
  runWebAutoMcp: (...args: unknown[]) => mockRunWebAutoMcp(...args),
}));

vi.mock("@/lib/web-auto/evaluator", () => ({
  runWebAutoEvaluation: (...args: unknown[]) => mockRunWebAutoEvaluation(...args),
}));

vi.mock("@/lib/runner/event-bus", () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
}));

vi.mock("@/lib/runner/notifications", () => ({
  recordRunNotification: (...args: unknown[]) => mockRecordRunNotification(...args),
}));

const mockGetWebAutoSuiteById = vi.fn();
const mockListEnabledWebAutoCasesForRun = vi.fn();
const mockCreateWebAutoRun = vi.fn();
const mockFinalizeWebAutoRun = vi.fn();
const mockWriteWebAutoCaseResult = vi.fn();

vi.mock("@/lib/web-auto/storage", () => ({
  getWebAutoSuiteById: (...args: unknown[]) => mockGetWebAutoSuiteById(...args),
  listEnabledWebAutoCasesForRun: (...args: unknown[]) => mockListEnabledWebAutoCasesForRun(...args),
  createWebAutoRun: (...args: unknown[]) => mockCreateWebAutoRun(...args),
  finalizeWebAutoRun: (...args: unknown[]) => mockFinalizeWebAutoRun(...args),
  writeWebAutoCaseResult: (...args: unknown[]) => mockWriteWebAutoCaseResult(...args),
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runWebAutoCase, startWebAutoSuiteRun } = await import(
  "@/lib/web-auto/orchestrator"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runWebAutoCase", () => {
  const dummySuite = {
    id: "suite-1",
    name: "Suite 1",
    mcpServerId: "mcp-1",
    evaluatorAgentId: null,
    variables: null,
    timeoutSec: 60,
  } as unknown as import("@/lib/db/schema").WebAutoSuiteEntity;

  it("returns errored when case has no script content", async () => {
    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: dummySuite,
      case: { id: 1, input: {}, assertions: [] } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.error?.message).toContain("no script content");
  });

  it("returns errored when suite has no mcpServerId", async () => {
    const suiteNoMcp = { ...dummySuite, mcpServerId: null };
    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: suiteNoMcp,
      case: { id: 1, input: { script: "return 1;" }, assertions: [] } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.error?.message).toContain("no MCP server configured");
  });

  it("returns failed when deterministic assertions fail", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { count: 5 } },
      error: null,
      durationMs: 500,
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: 1,
        input: { script: "return { count: 5 };" },
        assertions: [{ type: "js_expression", expression: "result.count === 10" }],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.verdict.deterministic.passed).toBe(false);
  });

  it("returns passed when execution succeeds and all assertions pass", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { success: true } },
      error: null,
      durationMs: 300,
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: 1,
        input: { script: "return { success: true };" },
        assertions: [{ type: "js_expression", expression: "result.success === true" }],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.verdict.overall.passed).toBe(true);
  });

  it("returns errored (never a silent pass) when evaluator is missing but llm_judge expectations exist and deterministic assertions pass", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 300,
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: dummySuite, // evaluatorAgentId: null
      case: {
        id: 1,
        input: { script: "return { ok: true };" },
        assertions: [
          { type: "js_expression", expression: "result.ok === true" },
          { type: "expectation", expectation: "Success banner is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.score).toBeUndefined();
    expect(outcome.verdict.overall.passed).toBe(false);
    expect(outcome.verdict.overall.reason).toContain("Evaluator agent is not configured");
    expect(outcome.error?.source).toBe("config");
    expect(outcome.error?.details).toEqual({ missing: "evaluatorAgentId", suiteId: "suite-1" });

    const deterministic = outcome.assertionResults.find((r) => r.type === "js_expression");
    const llm = outcome.assertionResults.find((r) => r.type === "llm_judge");
    expect(deterministic?.ok).toBe(true);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.score).toBeUndefined();
    expect(llm?.reason).toContain("Evaluator agent is not configured");
  });

  it("returns failed when deterministic assertions fail even when the evaluator is missing", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: false } },
      error: null,
      durationMs: 300,
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: 1,
        input: { script: "return { ok: false };" },
        assertions: [
          { type: "js_expression", expression: "result.ok === true" },
          { type: "expectation", expectation: "Success banner is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.score).toBe(0);
    expect(outcome.verdict.overall.passed).toBe(false);
    expect(outcome.verdict.overall.reason).toBe("Deterministic assertions failed");

    const deterministic = outcome.assertionResults.find((r) => r.type === "js_expression");
    const llm = outcome.assertionResults.find((r) => r.type === "llm_judge");
    expect(deterministic?.ok).toBe(false);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.score).toBeUndefined();
  });

  it("evaluates llm expectations normally (scored, not skipped) when an evaluator is configured", async () => {
    const suiteWithEvaluator = { ...dummySuite, evaluatorAgentId: "eval-1" };
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 300,
    });
    mockRunWebAutoEvaluation.mockResolvedValueOnce({
      passed: true,
      score: 88,
      feedback: "Looks good",
      expectationResults: [{ index: 0, score: 88, reason: "Banner present" }],
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: suiteWithEvaluator,
      case: {
        id: 1,
        input: { script: "return { ok: true };" },
        assertions: [
          { type: "js_expression", expression: "result.ok === true" },
          { type: "expectation", expectation: "Success banner is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(mockRunWebAutoEvaluation).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("passed");
    expect(outcome.score).toBe(88);

    const llm = outcome.assertionResults.find((r) => r.type === "llm_judge");
    expect(llm?.ok).toBe(true);
    expect(llm?.score).toBe(88);
    expect(llm?.skipped).toBeUndefined();
  });

  it("keeps configured-but-failing LLM evaluation as a scored failed case (not skipped/errored)", async () => {
    const suiteWithEvaluator = { ...dummySuite, evaluatorAgentId: "eval-1" };
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 300,
    });
    mockRunWebAutoEvaluation.mockResolvedValueOnce({
      passed: false,
      score: 40,
      feedback: "Banner missing",
      expectationResults: [{ index: 0, score: 40, reason: "not visible" }],
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: suiteWithEvaluator,
      case: {
        id: 1,
        input: { script: "return { ok: true };" },
        assertions: [{ type: "expectation", expectation: "Success banner is visible" }],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.score).toBe(40);
    expect(outcome.error).toBeNull();

    const llm = outcome.assertionResults.find((r) => r.type === "llm_judge");
    expect(llm?.ok).toBe(false);
    expect(llm?.score).toBe(40);
    expect(llm?.skipped).toBeUndefined();
  });
});

describe("startWebAutoSuiteRun", () => {
  it("orchestrates suite run, publishes SSE frames, and finalizes run", async () => {
    const dummySuite = {
      id: "suite-1",
      name: "Checkout Suite",
      mcpServerId: "mcp-1",
      evaluatorAgentId: null,
      variables: null,
      timeoutSec: 60,
    };

    const dummyCases = [
      {
        id: 1,
        name: "Case 1",
        input: { script: "return { ok: true };" },
        assertions: [],
        enabled: true,
      },
    ];

    mockGetWebAutoSuiteById.mockResolvedValueOnce(dummySuite);
    mockListEnabledWebAutoCasesForRun.mockResolvedValueOnce(dummyCases);
    mockCreateWebAutoRun.mockResolvedValueOnce({ id: "run-100" });

    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 200,
    });

    const result = await startWebAutoSuiteRun({
      suiteId: "suite-1",
      ownerId: "user-1",
    });

    expect(result).toEqual({ runId: "run-100", totalCount: 1 });

    // Allow background loop to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 1. Should publish run_started, case_finished, run_finished
    expect(mockPublish).toHaveBeenCalledTimes(3);
    expect(mockPublish).toHaveBeenNthCalledWith(
      1,
      "user-1",
      expect.objectContaining({
        frame: expect.objectContaining({ kind: "run_started", runId: "run-100" }),
      })
    );
    expect(mockPublish).toHaveBeenNthCalledWith(
      2,
      "user-1",
      expect.objectContaining({
        frame: expect.objectContaining({ kind: "case_finished", caseId: 1, status: "passed" }),
      })
    );
    expect(mockPublish).toHaveBeenNthCalledWith(
      3,
      "user-1",
      expect.objectContaining({
        frame: expect.objectContaining({ kind: "run_finished", status: "passed" }),
      })
    );

    // 2. Should write case result and finalize run in DB
    expect(mockWriteWebAutoCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-100",
        caseId: 1,
        status: "passed",
      })
    );
    expect(mockFinalizeWebAutoRun).toHaveBeenCalledWith({
      runId: "run-100",
      status: "passed",
      passedCount: 1,
      failedCount: 0,
      erroredCount: 0,
    });

    // 3. Should record notification
    expect(mockRecordRunNotification).toHaveBeenCalled();
  });
});