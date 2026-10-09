import { describe, expect, it, vi, beforeEach } from "vitest";

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
    caseTimeoutSec: 60,
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
      durationMs: 250, // Execution elapsed 250ms (not caseTimeoutSec)
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

  it("triggers onExecutionComplete callback before assertions evaluation", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { pageLoaded: true } },
      error: null,
      durationMs: 320,
    });

    const onExecutionComplete = vi.fn();

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: 1,
        input: { script: "return { pageLoaded: true };" },
        assertions: [{ type: "js_expression", expression: "result.pageLoaded === true" }],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
      onExecutionComplete,
    });

    expect(outcome.status).toBe("passed");
    expect(onExecutionComplete).toHaveBeenCalledTimes(1);
    expect(onExecutionComplete).toHaveBeenCalledWith({
      executionOutput: { result: { pageLoaded: true } },
      durationMs: 320,
    });
  });

  it("returns errored (never a silent pass) when evaluator is missing but llm_custom expectations exist and deterministic assertions pass", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 250, // Execution elapsed 250ms (not caseTimeoutSec)
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
          { type: "llm_custom", expectation: "Success banner is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.score).toBeUndefined();
    expect(outcome.verdict.overall.passed).toBe(false);
    expect(outcome.verdict.overall.reason).toContain("no evaluator agent is configured");
    expect(outcome.error?.source).toBe("config");
    expect(outcome.error?.details).toEqual({ missing: "evaluatorAgentId", suiteId: "suite-1" });

    const deterministic = outcome.assertionResults.find((r) => r.type === "js_expression");
    const llm = outcome.assertionResults.find((r) => r.type === "llm_custom");
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
      durationMs: 250, // Execution elapsed 250ms (not caseTimeoutSec)
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
          { type: "llm_custom", expectation: "Success banner is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.score).toBeUndefined();
    expect(outcome.verdict.overall.passed).toBe(false);
    expect(outcome.verdict.overall.reason).toContain("Deterministic assertion checks failed");

    const deterministic = outcome.assertionResults.find((r) => r.type === "js_expression");
    const llm = outcome.assertionResults.find((r) => r.type === "llm_custom");
    expect(deterministic?.ok).toBe(false);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.score).toBeUndefined();
  });

  it("short-circuits and does not invoke evaluator when deterministic assertions fail even if evaluator is configured", async () => {
    const suiteWithEvaluator = { ...dummySuite, evaluatorAgentId: "eval-1" };
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: false } },
      error: null,
      durationMs: 250,
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: suiteWithEvaluator,
      case: {
        id: 1,
        input: { script: "return { ok: false };" },
        assertions: [
          { type: "js_expression", expression: "result.ok === true" },
          { type: "llm_custom", expectation: "Success banner is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(mockRunWebAutoEvaluation).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(outcome.verdict.overall.passed).toBe(false);
    expect(outcome.verdict.overall.reason).toContain("Deterministic assertion checks failed");
    expect(outcome.feedback).toBeUndefined();

    const deterministic = outcome.assertionResults.find((r) => r.type === "js_expression");
    const llm = outcome.assertionResults.find((r) => r.type === "llm_custom");
    expect(deterministic?.ok).toBe(false);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
  });

  it("evaluates llm expectations normally (scored, not skipped) when an evaluator is configured", async () => {
    const suiteWithEvaluator = { ...dummySuite, evaluatorAgentId: "eval-1" };
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 250, // Execution elapsed 250ms (not caseTimeoutSec)
    });
    mockRunWebAutoEvaluation.mockResolvedValueOnce({
      passed: true,
      score: 4,
      feedback: "Looks good",
      expectationResults: [{ index: 0, score: 4, reason: "Banner present" }],
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
          { type: "llm_custom", expectation: "Success banner is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(mockRunWebAutoEvaluation).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("passed");
    expect(outcome.score).toBe(4);

    const llm = outcome.assertionResults.find((r) => r.type === "llm_custom");
    expect(llm?.ok).toBe(true);
    expect(llm?.score).toBe(4);
    expect(llm?.skipped).toBeUndefined();
  });

  it("keeps configured-but-failing LLM evaluation as a scored failed case (not skipped/errored)", async () => {
    const suiteWithEvaluator = { ...dummySuite, evaluatorAgentId: "eval-1" };
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 250, // Execution elapsed 250ms (not caseTimeoutSec)
    });
    mockRunWebAutoEvaluation.mockResolvedValueOnce({
      passed: false,
      score: 2,
      feedback: "Banner missing",
      expectationResults: [{ index: 0, score: 2, reason: "not visible" }],
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: suiteWithEvaluator,
      case: {
        id: 1,
        input: { script: "return { ok: true };" },
        assertions: [{ type: "llm_custom", expectation: "Success banner is visible" }],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.score).toBe(2);
    expect(outcome.error).toBeNull();

    const llm = outcome.assertionResults.find((r) => r.type === "llm_custom");
    expect(llm?.ok).toBe(false);
    expect(llm?.score).toBe(2);
    expect(llm?.skipped).toBeUndefined();
  });

  it("marks case as errored when evaluator omits a score for an expectation item", async () => {
    const suiteWithEvaluator = { ...dummySuite, evaluatorAgentId: "eval-1" };
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 250,
    });
    mockRunWebAutoEvaluation.mockResolvedValueOnce({
      passed: false,
      score: undefined,
      feedback: "Partial submission",
      error: {
        source: "internal",
        message: "Evaluator omitted score for check item 1",
      },
      expectationResults: [
        { index: 0, score: 5, reason: "Header ok" },
        { index: 1, score: 0, reason: "Evaluator failed to submit score for this item" },
      ],
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: suiteWithEvaluator,
      case: {
        id: 1,
        input: { script: "return { ok: true };" },
        assertions: [
          { type: "llm_custom", expectation: "Header is visible" },
          { type: "llm_custom", expectation: "Footer is visible" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.error).toBeDefined();
    expect(outcome.error?.message).toContain("Evaluator omitted score for check item 1");

    const omittedAssertion = outcome.assertionResults[1];
    expect(omittedAssertion.errored).toBe(true);
    expect(omittedAssertion.ok).toBe(false);
  });

  it("marks case as errored and retains deterministic results without fake score when evaluator throws exception (W5)", async () => {
    const suiteWithEvaluator = { ...dummySuite, evaluatorAgentId: "eval-1" };
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { pageLoaded: true } },
      error: null,
      durationMs: 200,
    });
    mockRunWebAutoEvaluation.mockRejectedValueOnce(
      new Error("Agent execution timeout or network failure"),
    );

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: suiteWithEvaluator,
      case: {
        id: 1,
        input: { script: "return { pageLoaded: true };" },
        assertions: [
          { type: "js_expression", expression: "result.pageLoaded === true" },
          { type: "llm_custom", expectation: "Dashboard widget renders correctly" },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    // W5: Must be errored, NOT failed with score 1
    expect(outcome.status).toBe("errored");
    expect(outcome.score).toBeUndefined();
    expect(outcome.error).toBeDefined();
    expect(outcome.error?.message).toContain("Agent execution timeout or network failure");

    // Deterministic assertion succeeded
    const deterministic = outcome.assertionResults.find((r) => r.type === "js_expression");
    expect(deterministic?.ok).toBe(true);
    expect(deterministic?.errored).toBeFalsy();

    // LLM assertion is skipped & errored (unreviewed), NOT scored 1
    const llm = outcome.assertionResults.find((r) => r.type === "llm_custom");
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.errored).toBe(true);
    expect(llm?.score).toBeUndefined();
  });

  it("passes suite.caseTimeoutSec to runWebAutoMcp and evaluates duration_s metric assertion successfully", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { loaded: true } },
      error: null,
      durationMs: 1500, // 1.5 seconds
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: { ...dummySuite, caseTimeoutSec: 45 },
      case: {
        id: 1,
        input: { script: "return { loaded: true };" },
        assertions: [
          { type: "metric", metric: "duration_s", operator: "<", threshold: 3.0 },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(mockRunWebAutoMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        caseTimeoutSec: 45,
      }),
    );
    expect(outcome.status).toBe("passed");
    expect(outcome.verdict.deterministic.passed).toBe(true);
    const metricRes = outcome.assertionResults.find((r) => r.type === "metric");
    expect(metricRes?.ok).toBe(true);
    expect(metricRes?.metric).toBe("duration_s");
    expect(metricRes?.actual).toBe(1.5);
  });

  it("fails duration_s metric assertion when execution duration exceeds threshold", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { loaded: true } },
      error: null,
      durationMs: 4200, // 4.2 seconds
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: dummySuite,
      case: {
        id: 1,
        input: { script: "return { loaded: true };" },
        assertions: [
          { type: "metric", metric: "duration_s", operator: "<", threshold: 2.0 },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.verdict.deterministic.passed).toBe(false);
    const metricRes = outcome.assertionResults.find((r) => r.type === "metric");
    expect(metricRes?.ok).toBe(false);
    expect(metricRes?.metric).toBe("duration_s");
    expect(metricRes?.actual).toBe(4.2);
  });

  it("reclassifies timeout errored to failed when duration_s SLA threshold is lower than caseTimeoutSec", async () => {
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "errored",
      executionOutput: null,
      error: {
        source: "timeout",
        message: "Tool execution timed out",
      },
      durationMs: 60000,
    });

    const outcome = await runWebAutoCase({
      caseId: 1,
      suiteId: "suite-1",
      suite: { ...dummySuite, caseTimeoutSec: 60 },
      case: {
        id: 1,
        input: { script: "return { loaded: true };" },
        assertions: [
          { type: "metric", metric: "duration_s", operator: "<", threshold: 10.0 },
        ],
      } as unknown as import("@/lib/db/schema").WebAutoCaseEntity,
      ownerId: "user-1",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.verdict.deterministic.passed).toBe(false);
    expect(outcome.verdict.overall.reason).toContain("exceeding SLA threshold of 10s");
    const metricRes = outcome.assertionResults.find((r) => r.type === "metric");
    expect(metricRes?.ok).toBe(false);
    expect(metricRes?.actual).toBe(">= 60s (timed out)");
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
      caseTimeoutSec: 60,
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

  it("does not abort or error subsequent cases when cumulative suite duration exceeds caseTimeoutSec", async () => {
    const dummySuite = {
      id: "suite-multi",
      name: "Multi-case Suite",
      mcpServerId: "mcp-1",
      evaluatorAgentId: null,
      variables: null,
      caseTimeoutSec: 1, // 1 second timeout (per case)
    };

    const dummyCases = [
      {
        id: 1,
        name: "Case 1",
        input: { script: "return { step: 1 };" },
        assertions: [],
        enabled: true,
      },
      {
        id: 2,
        name: "Case 2",
        input: { script: "return { step: 2 };" },
        assertions: [],
        enabled: true,
      },
    ];

    mockGetWebAutoSuiteById.mockResolvedValueOnce(dummySuite);
    mockListEnabledWebAutoCasesForRun.mockResolvedValueOnce(dummyCases);
    mockCreateWebAutoRun.mockResolvedValueOnce({ id: "run-multi" });

    // Mock MCP execution for both cases with success
    mockRunWebAutoMcp
      .mockResolvedValueOnce({
        status: "success",
        executionOutput: { result: { step: 1 } },
        error: null,
        durationMs: 600,
      })
      .mockResolvedValueOnce({
        status: "success",
        executionOutput: { result: { step: 2 } },
        error: null,
        durationMs: 600,
      });

    await startWebAutoSuiteRun({
      suiteId: "suite-multi",
      ownerId: "user-1",
    });

    // Wait for suite execution loop
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Both cases should run and pass, not be skipped with 'Suite timeout exceeded'
    expect(mockFinalizeWebAutoRun).toHaveBeenCalledWith({
      runId: "run-multi",
      status: "passed",
      passedCount: 2,
      failedCount: 0,
      erroredCount: 0,
    });
  });

  it("does not fail the run when recordRunNotification throws during finaliseAndAnnounce", async () => {
    const dummySuite = {
      id: "suite-notif-fail",
      name: "Notif Fail Suite",
      mcpServerId: "mcp-1",
      evaluatorAgentId: null,
      variables: null,
      caseTimeoutSec: 60,
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
    mockCreateWebAutoRun.mockResolvedValueOnce({ id: "run-notif-fail" });
    mockRunWebAutoMcp.mockResolvedValueOnce({
      status: "success",
      executionOutput: { result: { ok: true } },
      error: null,
      durationMs: 100,
    });
    mockRecordRunNotification.mockRejectedValueOnce(new Error("Notification DB deadlock"));

    await startWebAutoSuiteRun({
      suiteId: "suite-notif-fail",
      ownerId: "user-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(mockFinalizeWebAutoRun).toHaveBeenCalledWith({
      runId: "run-notif-fail",
      status: "passed",
      passedCount: 1,
      failedCount: 0,
      erroredCount: 0,
    });
  });

  it("handles crash gracefully even when recordRunNotification throws during handleSuiteLoopCrash", async () => {
    const dummySuite = {
      id: "suite-crash-notif-fail",
      name: "Crash Notif Fail Suite",
      mcpServerId: "mcp-1",
      evaluatorAgentId: null,
      variables: null,
      caseTimeoutSec: 60,
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
    mockCreateWebAutoRun.mockResolvedValueOnce({ id: "run-crash-notif-fail" });
    mockRunWebAutoMcp.mockRejectedValueOnce(new Error("Fatal Playwright container exit"));
    mockRecordRunNotification.mockRejectedValueOnce(new Error("Notification table locked"));

    await startWebAutoSuiteRun({
      suiteId: "suite-crash-notif-fail",
      ownerId: "user-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(mockFinalizeWebAutoRun).toHaveBeenCalledWith({
      runId: "run-crash-notif-fail",
      status: "errored",
      passedCount: 0,
      failedCount: 0,
      erroredCount: 1,
    });
  });
});