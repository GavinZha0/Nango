import { describe, expect, it, vi, beforeEach } from "vitest";

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

  it("passes when evaluator submits score >= threshold", async () => {
    mockRunnerStart.mockResolvedValueOnce({ status: "succeeded", runId: "run-eval-2" });
    mockReadEvents.mockResolvedValueOnce([
      {
        type: "tool_call_chunk",
        payload: {
          toolName: "submit_evaluation_scores",
          args: JSON.stringify({
            item_scores: [{ index: 0, score: 4, reason: "UI looks good and match expectations" }],
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
    expect(res.score).toBe(4);
    expect(res.feedback).toBe("UI looks good and match expectations");
  });

  it("marks as failed when evaluator submits score < threshold", async () => {
    mockRunnerStart.mockResolvedValueOnce({ status: "succeeded", runId: "run-eval-3" });
    mockReadEvents.mockResolvedValueOnce([
      {
        type: "tool_call_chunk",
        payload: {
          toolName: "submit_evaluation_scores",
          args: JSON.stringify({
            item_scores: [{ index: 0, score: 2, reason: "Button was missing in the DOM" }],
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
    expect(res.score).toBe(2);
    expect(res.feedback).toBe("Button was missing in the DOM");
  });

  it("supports batch item_scores with individual scores and reasons", async () => {
    mockRunnerStart.mockResolvedValueOnce({ status: "succeeded", runId: "run-eval-4" });
    mockReadEvents.mockResolvedValueOnce([
      {
        type: "tool_call_chunk",
        payload: {
          toolName: "submit_evaluation_scores",
          args: JSON.stringify({
            item_scores: [
              { index: 0, score: 5, reason: "Header is perfectly visible." },
              { index: 1, score: 5, reason: "No error toast appeared." },
              { index: 2, score: 4, reason: "Matches reference text." },
            ],
            feedback: "Overall UI workflow succeeded cleanly.",
          }),
        },
      },
    ]);

    const res = await runWebAutoEvaluation({
      evaluatorAgentId: "agent-1",
      executionOutput: { dom: "<div><h1>Dashboard</h1></div>" },
      expectations: [
        { expectation: "Header is visible" },
        { unexpectation: "Error toast appears" },
        { reference: "Dashboard" },
      ],
      ownerId: "user-1",
    });

    expect(res.passed).toBe(true);
    expect(res.score).toBe(4);
    expect(res.expectationResults).toHaveLength(3);
    expect(res.expectationResults[0].score).toBe(5);
    expect(res.expectationResults[0].reason).toBe("Header is perfectly visible.");
    expect(res.expectationResults[1].score).toBe(5);
    expect(res.expectationResults[1].reason).toBe("No error toast appeared.");
    expect(res.expectationResults[2].score).toBe(4);
    expect(res.expectationResults[2].reason).toBe("Matches reference text.");
  });
});