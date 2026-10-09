import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSuiteByIdMock,
  listEnabledCasesForRunMock,
  createRunMock,
  writeCaseResultMock,
  finalizeRunMock,
  runMcpCaseMock,
  publishVerificationFrameMock,
  recordRunNotificationMock,
} = vi.hoisted(() => ({
  getSuiteByIdMock: vi.fn(),
  listEnabledCasesForRunMock: vi.fn(),
  createRunMock: vi.fn(),
  writeCaseResultMock: vi.fn(),
  finalizeRunMock: vi.fn(),
  runMcpCaseMock: vi.fn(),
  publishVerificationFrameMock: vi.fn(),
  recordRunNotificationMock: vi.fn(),
}));

vi.mock("@/lib/verification/storage", () => ({
  getSuiteById: getSuiteByIdMock,
  listEnabledCasesForRun: listEnabledCasesForRunMock,
  createRun: createRunMock,
  writeCaseResult: writeCaseResultMock,
  finalizeRun: finalizeRunMock,
}));

vi.mock("@/lib/verification/runner-mcp", () => ({
  runMcpCase: runMcpCaseMock,
}));

vi.mock("@/lib/verification/event-bus-channel", () => ({
  publishVerificationFrame: publishVerificationFrameMock,
}));

vi.mock("@/lib/runner/notifications", () => ({
  recordRunNotification: recordRunNotificationMock,
}));

vi.mock("@/lib/testing/variable-resolver.server", () => ({
  resolveSuiteVariables: vi.fn().mockResolvedValue({ literalVariables: {}, error: null }),
}));

import { startSuiteRun } from "@/lib/verification/run-orchestrator";

describe("run-orchestrator persistence and failure handling (R4)", () => {
  const sampleSuite = {
    id: "suite-uuid-1",
    name: "Verification Suite 1",
    groupId: null,
  };

  const sampleCases = [
    {
      id: 101,
      suiteId: "suite-uuid-1",
      name: "010-first-test",
      mcpServerId: "srv-1",
      mcpServerName: "Server 1",
      toolName: "fetch_data",
      toolPrefixRule: null,
      caseTimeoutSec: 30,
      input: { q: "foo" },
      assertions: [],
    },
    {
      id: 102,
      suiteId: "suite-uuid-1",
      name: "020-second-test",
      mcpServerId: "srv-1",
      mcpServerName: "Server 1",
      toolName: "fetch_data",
      toolPrefixRule: null,
      caseTimeoutSec: 30,
      input: { q: "bar" },
      assertions: [],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    getSuiteByIdMock.mockResolvedValue(sampleSuite);
    listEnabledCasesForRunMock.mockResolvedValue(sampleCases);
    createRunMock.mockResolvedValue({ id: "run-uuid-1" });
    writeCaseResultMock.mockResolvedValue({});
    finalizeRunMock.mockResolvedValue(undefined);
    recordRunNotificationMock.mockResolvedValue(undefined);
    runMcpCaseMock.mockResolvedValue({
      status: "passed",
      resolvedInput: { q: "foo" },
      resultPayload: { success: true },
      resultTruncated: false,
      assertionResults: [],
      durationMs: 42,
    });
  });

  it("completes normally and persists passed results when storage succeeds", async () => {
    const onFinish = vi.fn();
    const result = await startSuiteRun({
      suiteId: sampleSuite.id,
      ownerId: "user-1",
      triggeredBy: "manual",
      onFinish,
    });

    expect(result.runId).toBe("run-uuid-1");
    expect(result.totalCount).toBe(2);

    // Wait for asynchronous background loop
    await vi.waitFor(() => {
      expect(finalizeRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-uuid-1",
          status: "passed",
          passedCount: 2,
        }),
      );
    });

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "passed",
        passedCount: 2,
      }),
    );

    // Verified frames: run_started, 2 case_finished (passed), run_finished (passed)
    const caseFinishedCalls = publishVerificationFrameMock.mock.calls.filter(
      (c) => c[1]?.kind === "case_finished",
    );
    expect(caseFinishedCalls).toHaveLength(2);
    expect(caseFinishedCalls[0][1].status).toBe("passed");
    expect(caseFinishedCalls[1][1].status).toBe("passed");

    const runFinishedCall = publishVerificationFrameMock.mock.calls.find(
      (c) => c[1]?.kind === "run_finished",
    );
    expect(runFinishedCall).toBeDefined();
    expect(runFinishedCall![1].status).toBe("passed");
  });

  it("stops loop, skips case_finished frame, and marks run errored when case result INSERT fails", async () => {
    // Inject persistent failure into writeCaseResult
    writeCaseResultMock.mockRejectedValue(new Error("Database connection lost"));

    const onFinish = vi.fn();
    await startSuiteRun({
      suiteId: sampleSuite.id,
      ownerId: "user-1",
      triggeredBy: "manual",
      onFinish,
    });

    // Wait for loop to crash and finalize
    await vi.waitFor(() => {
      expect(finalizeRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-uuid-1",
          status: "errored",
        }),
      );
    });

    // 1. No case_finished event should be published
    const caseFinishedCalls = publishVerificationFrameMock.mock.calls.filter(
      (c) => c[1]?.kind === "case_finished",
    );
    expect(caseFinishedCalls).toHaveLength(0);

    // 2. Second case should not be scheduled / executed
    expect(runMcpCaseMock).toHaveBeenCalledTimes(1);

    // 3. onFinish and run_finished frame must report errored, NOT passed
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "errored",
      }),
    );

    const runFinishedCall = publishVerificationFrameMock.mock.calls.find(
      (c) => c[1]?.kind === "run_finished",
    );
    expect(runFinishedCall).toBeDefined();
    expect(runFinishedCall![1].status).toBe("errored");
  });

  it("recovers and records passed case result if retry succeeds within threshold", async () => {
    // Fail first attempt, succeed second attempt
    writeCaseResultMock
      .mockRejectedValueOnce(new Error("Transient lock timeout"))
      .mockResolvedValueOnce({});

    listEnabledCasesForRunMock.mockResolvedValue([sampleCases[0]]);

    await startSuiteRun({
      suiteId: sampleSuite.id,
      ownerId: "user-1",
      triggeredBy: "manual",
    });

    await vi.waitFor(() => {
      expect(finalizeRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "passed",
          passedCount: 1,
        }),
      );
    });

    // Only storage was retried, MCP tool was NOT called again!
    expect(runMcpCaseMock).toHaveBeenCalledTimes(1);
    expect(writeCaseResultMock).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite or fail test verdict when notification dispatch fails", async () => {
    recordRunNotificationMock.mockRejectedValue(new Error("Notification queue failure"));

    const onFinish = vi.fn();
    await startSuiteRun({
      suiteId: sampleSuite.id,
      ownerId: "user-1",
      triggeredBy: "manual",
      onFinish,
    });

    await vi.waitFor(() => {
      expect(finalizeRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "passed",
        }),
      );
    });

    // onFinish and run_finished must still be passed
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "passed",
      }),
    );

    const runFinishedCall = publishVerificationFrameMock.mock.calls.find(
      (c) => c[1]?.kind === "run_finished",
    );
    expect(runFinishedCall).toBeDefined();
    expect(runFinishedCall![1].status).toBe("passed");
  });

  it("downgrades broadcast status to errored if finalizeRun fails in DB", async () => {
    finalizeRunMock.mockRejectedValue(new Error("DB read-only mode"));

    const onFinish = vi.fn();
    await startSuiteRun({
      suiteId: sampleSuite.id,
      ownerId: "user-1",
      triggeredBy: "manual",
      onFinish,
    });

    await vi.waitFor(() => {
      expect(onFinish).toHaveBeenCalled();
    });

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "errored",
      }),
    );

    const runFinishedCall = publishVerificationFrameMock.mock.calls.find(
      (c) => c[1]?.kind === "run_finished",
    );
    expect(runFinishedCall).toBeDefined();
    expect(runFinishedCall![1].status).toBe("errored");
  });
});
