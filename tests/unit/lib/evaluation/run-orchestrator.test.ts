import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSuiteByIdMock,
  listEnabledCasesForRunMock,
  listCasesByIdsMock,
  createRunMock,
  finalizeRunMock,
  publishMock,
} = vi.hoisted(() => ({
  getSuiteByIdMock: vi.fn(),
  listEnabledCasesForRunMock: vi.fn(),
  listCasesByIdsMock: vi.fn(),
  createRunMock: vi.fn(),
  finalizeRunMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock("@/lib/evaluation/storage", () => ({
  getSuiteById: getSuiteByIdMock,
  listEnabledCasesForRun: listEnabledCasesForRunMock,
  listCasesByIds: listCasesByIdsMock,
  createRun: createRunMock,
  finalizeRun: finalizeRunMock,
}));

vi.mock("@/lib/runner/event-bus", () => ({
  publish: publishMock,
}));

vi.mock("@/lib/evaluation/eval-runner", () => ({
  runEvalCase: vi.fn(),
}));

import { startEvalSuiteRun } from "@/lib/evaluation/run-orchestrator";
import { ApiError } from "@/lib/http/route-handlers";

describe("run-orchestrator — empty suite and no-target rejection (E13)", () => {
  const sampleSuite = {
    id: "suite-uuid-1",
    name: "Customer Evaluation Suite",
    threshold: 3,
    agentId: "agent-1",
    agentSource: "builtin",
    evaluatorAgentId: "eval-1",
    caseTimeoutSec: 60,
    variables: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getSuiteByIdMock.mockResolvedValue(sampleSuite);
  });

  it("rejects execution with 400 Bad Request when suite has 0 enabled cases", async () => {
    listEnabledCasesForRunMock.mockResolvedValue([]);

    await expect(
      startEvalSuiteRun({
        suiteId: sampleSuite.id,
        ownerId: "user-1",
        triggeredBy: "manual",
      }),
    ).rejects.toThrow(ApiError);

    // CONTRACT (E13): No run created in DB, no phantom 0/0 passed event emitted
    expect(createRunMock).not.toHaveBeenCalled();
    expect(finalizeRunMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("rejects execution with 400 Bad Request when all cases matching caseIds are absent", async () => {
    listCasesByIdsMock.mockResolvedValue([]);

    await expect(
      startEvalSuiteRun({
        suiteId: sampleSuite.id,
        ownerId: "user-1",
        triggeredBy: "manual",
        caseIds: [999],
      }),
    ).rejects.toThrow(ApiError);

    expect(createRunMock).not.toHaveBeenCalled();
    expect(finalizeRunMock).not.toHaveBeenCalled();
  });

  it("proceeds normally and creates run when enabled cases exist", async () => {
    listEnabledCasesForRunMock.mockResolvedValue([
      { id: 1, name: "Case 1", turns: [{ userMessage: "hello" }], assertions: [] },
    ]);
    createRunMock.mockResolvedValue({ id: "run-uuid-1" });

    const result = await startEvalSuiteRun({
      suiteId: sampleSuite.id,
      ownerId: "user-1",
      triggeredBy: "manual",
    });

    expect(result.runId).toBe("run-uuid-1");
    expect(result.totalCount).toBe(1);
    expect(createRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: sampleSuite.id,
        totalCount: 1,
      }),
    );
  });
});
