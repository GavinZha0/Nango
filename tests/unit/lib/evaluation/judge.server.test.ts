import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockRunnerStart, mockReadEvents, mockGetConfigNumber } = vi.hoisted(() => ({
  mockRunnerStart: vi.fn(),
  mockReadEvents: vi.fn(),
  mockGetConfigNumber: vi.fn(),
}));

vi.mock("@/lib/runner", () => ({
  runner: {
    start: (...args: unknown[]) => mockRunnerStart(...args),
  },
}));

vi.mock("@/lib/runner/event-store", () => ({
  readEvents: (...args: unknown[]) => mockReadEvents(...args),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfigNumber: (...args: unknown[]) => mockGetConfigNumber(...args),
  };
});

const {
  isLikertScoreValid,
  extractEvaluatorScores,
  withStepTimeout,
  executeJudge,
  EVALUATOR_RETRY_SYSTEM_WARNING,
} = await import("@/lib/evaluation/judge.server");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfigNumber.mockResolvedValue(300);
  mockReadEvents.mockResolvedValue([]);
  mockRunnerStart.mockResolvedValue({
    status: "succeeded",
    runId: "run-evaluator-1",
  });
});

describe("Unified Judge Server — judge.server.ts", () => {
  describe("1. Likert score validation", () => {
    it("accepts valid 1-5 integer scores", () => {
      expect(isLikertScoreValid(1)).toBe(true);
      expect(isLikertScoreValid(2)).toBe(true);
      expect(isLikertScoreValid(3)).toBe(true);
      expect(isLikertScoreValid(4)).toBe(true);
      expect(isLikertScoreValid(5)).toBe(true);
    });

    it("rejects scores outside 1-5 or non-integer values", () => {
      expect(isLikertScoreValid(0)).toBe(false);
      expect(isLikertScoreValid(6)).toBe(false);
      expect(isLikertScoreValid(-1)).toBe(false);
      expect(isLikertScoreValid(100)).toBe(false);
      expect(isLikertScoreValid(3.5)).toBe(false);
      expect(isLikertScoreValid("4")).toBe(false);
      expect(isLikertScoreValid(null)).toBe(false);
      expect(isLikertScoreValid(undefined)).toBe(false);
      expect(isLikertScoreValid(NaN)).toBe(false);
    });
  });

  describe("2. extractEvaluatorScores", () => {
    it("extracts valid submit_evaluation_scores in reverse chronological order", () => {
      const events = [
        {
          runId: "run-1",
          seq: 1,
          type: "tool_call_chunk",
          ts: new Date(),
          payload: {
            toolName: "submit_evaluation_scores",
            args: JSON.stringify({
              item_scores: [{ index: 0, score: 2, reason: "Attempt 1" }],
              feedback: "Attempt 1 feedback",
            }),
          },
        },
        {
          runId: "run-1",
          seq: 2,
          type: "tool_call_chunk",
          ts: new Date(),
          payload: {
            toolName: "submit_evaluation_scores",
            args: JSON.stringify({
              item_scores: [{ index: 0, score: 5, reason: "Final Attempt" }],
              feedback: "Final feedback",
            }),
          },
        },
      ];

      const scores = extractEvaluatorScores(events as never[]);
      expect(scores).not.toBeNull();
      expect(scores?.item_scores[0]?.score).toBe(5);
      expect(scores?.feedback).toBe("Final feedback");
    });

    it("skips invalid schema calls and falls back to earlier valid call", () => {
      const events = [
        {
          runId: "run-1",
          seq: 1,
          type: "tool_call_chunk",
          ts: new Date(),
          payload: {
            toolName: "submit_evaluation_scores",
            args: JSON.stringify({
              item_scores: [{ index: 0, score: 4, reason: "Valid call" }],
              feedback: "Valid feedback",
            }),
          },
        },
        {
          runId: "run-1",
          seq: 2,
          type: "tool_call_chunk",
          ts: new Date(),
          payload: {
            toolName: "submit_evaluation_scores",
            // Invalid schema: item_scores is missing required fields
            args: JSON.stringify({
              item_scores: [{ foo: "bar" }],
            }),
          },
        },
      ];

      const scores = extractEvaluatorScores(events as never[]);
      expect(scores).not.toBeNull();
      expect(scores?.item_scores[0]?.score).toBe(4);
    });
  });

  describe("3. withStepTimeout", () => {
    it("resolves when promise finishes within timeout", async () => {
      const res = await withStepTimeout(Promise.resolve("done"), 1000, "TestStep");
      expect(res).toBe("done");
    });

    it("rejects with step name and timeout duration when exceeded", async () => {
      const slowPromise = new Promise((resolve) => setTimeout(resolve, 200));
      await expect(withStepTimeout(slowPromise, 20, "Evaluator agent")).rejects.toThrow(
        "Evaluator agent timed out after 0.02s",
      );
    });
  });

  describe("4. executeJudge execution lifecycle", () => {
    it("succeeds on first attempt when evaluator submits scores", async () => {
      mockReadEvents.mockResolvedValue([
        {
          runId: "run-evaluator-1",
          seq: 1,
          type: "tool_call_chunk",
          ts: new Date(),
          payload: {
            toolName: "submit_evaluation_scores",
            args: JSON.stringify({
              item_scores: [{ index: 0, score: 4, reason: "Well done" }],
              feedback: "Overall good",
            }),
          },
        },
      ]);

      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Evaluate this task",
        ownerId: "user-1",
        timeoutMs: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.scores?.item_scores[0]?.score).toBe(4);
      expect(result.evaluatorRunId).toBe("run-evaluator-1");
      expect(mockRunnerStart).toHaveBeenCalledTimes(1);
      expect(mockRunnerStart).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "eval-agent-1",
          task: "Evaluate this task",
        }),
      );
    });

    it("retries with SYSTEM WARNING when evaluator omits tool call on first attempt", async () => {
      let callCount = 0;
      mockRunnerStart.mockImplementation(async () => {
        callCount++;
        return {
          status: "succeeded",
          runId: `run-eval-${callCount}`,
        };
      });

      mockReadEvents.mockImplementation(async (runId: string) => {
        if (runId === "run-eval-1") {
          // First attempt emits no tool call
          return [];
        }
        if (runId === "run-eval-2") {
          // Second attempt emits valid tool call
          return [
            {
              runId,
              seq: 1,
              type: "tool_call_chunk",
              ts: new Date(),
              payload: {
                toolName: "submit_evaluation_scores",
                args: JSON.stringify({
                  item_scores: [{ index: 0, score: 5, reason: "Perfect" }],
                  feedback: "Second try passed",
                }),
              },
            },
          ];
        }
        return [];
      });

      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Initial Prompt",
        ownerId: "user-1",
      });

      expect(result.success).toBe(true);
      expect(result.scores?.item_scores[0]?.score).toBe(5);
      expect(mockRunnerStart).toHaveBeenCalledTimes(2);

      // Verify second attempt prompt contains EVALUATOR_RETRY_SYSTEM_WARNING
      const secondCallArgs = mockRunnerStart.mock.calls[1][0];
      expect(secondCallArgs.task).toContain(EVALUATOR_RETRY_SYSTEM_WARNING);
    });

    it("handles timeout error and prevents infinite hanging", async () => {
      mockRunnerStart.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
      );

      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Prompt",
        ownerId: "user-1",
        timeoutMs: 10,
        maxRetries: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Evaluator agent timed out");
    });

    it("respects abort signal and cancels gracefully", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Prompt",
        ownerId: "user-1",
        signal: controller.signal,
      });

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(mockRunnerStart).not.toHaveBeenCalled();
    });

    it("handles maxRetries = 0 by skipping execution and returning structured failure", async () => {
      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Prompt",
        ownerId: "user-1",
        maxRetries: 0,
      });

      expect(result.success).toBe(false);
      expect(result.scores).toBeNull();
      expect(result.error).toContain("maxRetries set to 0");
      expect(mockRunnerStart).not.toHaveBeenCalled();
    });

    it("distinguishes schema validation failures with detailed field error diagnostics", async () => {
      mockRunnerStart.mockResolvedValue({
        status: "succeeded",
        runId: "run-bad-schema",
      });
      mockReadEvents.mockResolvedValue([
        {
          runId: "run-bad-schema",
          seq: 1,
          type: "tool_call_chunk",
          ts: new Date(),
          payload: {
            toolName: "submit_evaluation_scores",
            args: JSON.stringify({
              item_scores: [{ index: 0, score: 99, reason: "Invalid score" }],
            }),
          },
        },
      ]);

      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Prompt",
        ownerId: "user-1",
        maxRetries: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("failed schema validation");
    });

    it("distinguishes invalid JSON arguments in tool calls", async () => {
      mockRunnerStart.mockResolvedValue({
        status: "succeeded",
        runId: "run-bad-json",
      });
      mockReadEvents.mockResolvedValue([
        {
          runId: "run-bad-json",
          seq: 1,
          type: "tool_call_chunk",
          ts: new Date(),
          payload: {
            toolName: "submit_evaluation_scores",
            args: "not-json-content{{{",
          },
        },
      ]);

      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Prompt",
        ownerId: "user-1",
        maxRetries: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("arguments were not valid JSON");
    });

    it("distinguishes evaluator agent run failures", async () => {
      mockRunnerStart.mockResolvedValue({
        status: "failed",
        runId: "run-failed-status",
        errorMessage: "Model quota exceeded",
      });

      const result = await executeJudge({
        evaluatorAgentId: "eval-agent-1",
        taskPrompt: "Prompt",
        ownerId: "user-1",
        maxRetries: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Evaluator agent run failed: Model quota exceeded");
    });

    it("supports concurrent independent executeJudge calls", async () => {
      mockRunnerStart.mockImplementation(async (opts: { entityId: string }) => {
        return {
          status: "succeeded",
          runId: `run-${opts.entityId}`,
        };
      });

      mockReadEvents.mockImplementation(async (runId: string) => {
        const id = runId.replace("run-", "");
        return [
          {
            runId,
            seq: 1,
            type: "tool_call_chunk",
            ts: new Date(),
            payload: {
              toolName: "submit_evaluation_scores",
              args: JSON.stringify({
                item_scores: [{ index: 0, score: id === "agent-A" ? 4 : 5, reason: id }],
                feedback: `Feedback for ${id}`,
              }),
            },
          },
        ];
      });

      const [resA, resB] = await Promise.all([
        executeJudge({
          evaluatorAgentId: "agent-A",
          taskPrompt: "Prompt A",
          ownerId: "user-1",
        }),
        executeJudge({
          evaluatorAgentId: "agent-B",
          taskPrompt: "Prompt B",
          ownerId: "user-1",
        }),
      ]);

      expect(resA.success).toBe(true);
      expect(resA.scores?.item_scores[0]?.score).toBe(4);
      expect(resA.evaluatorRunId).toBe("run-agent-A");

      expect(resB.success).toBe(true);
      expect(resB.scores?.item_scores[0]?.score).toBe(5);
      expect(resB.evaluatorRunId).toBe("run-agent-B");
    });
  });
});
