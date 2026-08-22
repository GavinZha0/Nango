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
      caseId: "case-1",
      suiteId: "suite-1",
      suite: dummySuite,
      case: { id: "case-1", scriptContent: null, assertions: [] } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.error?.message).toContain("no script content");
  });

  it("returns errored when suite has no mcpServerId", async () => {
    const suiteNoMcp = { ...dummySuite, mcpServerId: null };
    const outcome = await runWebAutoCase({
      caseId: "case-1",
      suiteId: "suite-1",
      suite: suiteNoMcp,
      case: { id: "case-1", scriptContent: "return 1;", assertions: [] } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
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
      caseId: "case-1",
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: "case-1",
        scriptContent: "return { count: 5 };",
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
      caseId: "case-1",
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: "case-1",
        scriptContent: "return { success: true };",
        assertions: [{ type: "js_expression", expression: "result.success === true" }],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.verdict.overall.passed).toBe(true);
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
        id: "case-1",
        name: "Case 1",
        scriptContent: "return { ok: true };",
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
        frame: expect.objectContaining({ kind: "case_finished", caseId: "case-1", status: "passed" }),
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
        caseId: "case-1",
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