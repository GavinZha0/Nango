import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockRunnerStart = vi.fn();
const mockReadEvents = vi.fn();

vi.mock("@/lib/runner", () => ({
  runner: {
    start: (...args: unknown[]) => mockRunnerStart(...args),
  },
}));

vi.mock("@/lib/runner/event-store", () => ({
  readEvents: (...args: unknown[]) => mockReadEvents(...args),
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runWebAutoEvaluation } = await import("@/lib/web-auto/evaluator");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runWebAutoEvaluation", () => {
  it("auto-passes when expectations list is empty", async () => {
    const res = await runWebAutoEvaluation({
      evaluatorAgentId: "agent-1",
      executionOutput: { ok: true },
      expectations: [],
      ownerId: "user-1",
    });

    expect(res.passed).toBe(true);
    expect(res.expectationResults).toHaveLength(0);
    expect(mockRunnerStart).not.toHaveBeenCalled();
  });

  it("fails gracefully when evaluator fails to submit scores via tool call", async () => {
    mockRunnerStart.mockResolvedValue({ status: "succeeded", runId: "run-eval-1" });
    mockReadEvents.mockResolvedValue([]); // No tool_call_chunk with submit_evaluation_scores

    const res = await runWebAutoEvaluation({
      evaluatorAgentId: "agent-1",
      executionOutput: { ok: true },
      expectations: [{ expectation: "Header is visible" }],
      ownerId: "user-1",
    });

    expect(res.passed).toBe(false);
    expect(res.expectationResults[0].score).toBe(0);
    expect(res.error).toBeDefined();
  });

  it("passes when evaluator submits score >= 60", async () => {
    mockRunnerStart.mockResolvedValueOnce({ status: "succeeded", runId: "run-eval-2" });
    mockReadEvents.mockResolvedValueOnce([
      {
        type: "tool_call_chunk",
        payload: {
          toolName: "submit_evaluation_scores",
          args: JSON.stringify({
            baseline_score: 90,
            criteria_score: 85,
            feedback: "UI looks good and match expectations",
          }),
        },
      },
    ]);

    const res = await runWebAutoEvaluation({
      evaluatorAgentId: "agent-1",
      executionOutput: { ok: true },
      expectations: [{ expectation: "Header is visible" }],
      ownerId: "user-1",
    });

    expect(res.passed).toBe(true);
    expect(res.score).toBe(85);
    expect(res.feedback).toBe("UI looks good and match expectations");
  });

  it("marks as failed when evaluator submits score < 60", async () => {
    mockRunnerStart.mockResolvedValueOnce({ status: "succeeded", runId: "run-eval-3" });
    mockReadEvents.mockResolvedValueOnce([
      {
        type: "tool_call_chunk",
        payload: {
          toolName: "submit_evaluation_scores",
          args: JSON.stringify({
            baseline_score: 40,
            criteria_score: 45,
            feedback: "Button was missing in the DOM",
          }),
        },
      },
    ]);

    const res = await runWebAutoEvaluation({
      evaluatorAgentId: "agent-1",
      executionOutput: { ok: true },
      expectations: [{ expectation: "Submit button is enabled" }],
      ownerId: "user-1",
    });

    expect(res.passed).toBe(false);
    expect(res.score).toBe(45);
    expect(res.feedback).toBe("Button was missing in the DOM");
  });
});