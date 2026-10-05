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

  it("rejects score > 5 via schema validation and reports evaluator error", async () => {
    mockRunnerStart.mockResolvedValue({ status: "succeeded", runId: "run-eval-invalid-score" });
    mockReadEvents.mockResolvedValue([
      {
        type: "tool_call_chunk",
        payload: {
          toolName: "submit_evaluation_scores",
          args: JSON.stringify({
            item_scores: [{ index: 0, score: 15, reason: "Prohibited content appeared" }],
            feedback: "Evaluation found forbidden elements",
          }),
        },
      },
    ]);

    const res = await runWebAutoEvaluation({
      evaluatorAgentId: "agent-1",
      executionOutput: { ok: false },
      expectations: [{ unexpectation: "Error toast" }],
      ownerId: "user-1",
    });

    expect(res.passed).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain("submit_evaluation_scores");
  });

  it("marks omitted check items with score 0 and flags evaluator error without guessing positions or defaulting to score 1", async () => {
    mockRunnerStart.mockResolvedValueOnce({ status: "succeeded", runId: "run-eval-omitted" });
    mockReadEvents.mockResolvedValueOnce([
      {
        type: "tool_call_chunk",
        payload: {
          toolName: "submit_evaluation_scores",
          args: JSON.stringify({
            item_scores: [{ index: 0, score: 5, reason: "Header is visible" }],
            feedback: "Partial evaluation",
          }),
        },
      },
    ]);

    const res = await runWebAutoEvaluation({
      evaluatorAgentId: "agent-1",
      executionOutput: { ok: true },
      expectations: [
        { expectation: "Header is visible" },
        { expectation: "Footer is visible" },
      ],
      ownerId: "user-1",
    });

    expect(res.passed).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain("Evaluator omitted score for check item 1");
    expect(res.expectationResults).toHaveLength(2);
    expect(res.expectationResults[0].score).toBe(5);
    expect(res.expectationResults[1].score).toBe(0);
  });
});

describe("buildWebAutoEvaluationPrompt", () => {
  it("uses 1-5 Likert scale rubric and avoids legacy 0-100 scale thresholds", async () => {
    const { buildWebAutoEvaluationPrompt } = await import("@/lib/web-auto/evaluator");
    const prompt = buildWebAutoEvaluationPrompt(
      { text: "sample output" },
      [
        { expectation: "Submit button is enabled" },
        { unexpectation: "Error modal appeared" },
        { reference: "Expected headline" },
      ],
    );

    // Verify 1-5 Likert scale instructions
    expect(prompt).toContain("score >= 3");
    expect(prompt).toContain("score 1-2");
    expect(prompt).toContain("score 4-5");
    expect(prompt).toContain("1-5 Likert scale");

    // Strictly ensure no legacy 0-100 scores exist
    expect(prompt).not.toContain("score >= 60");
    expect(prompt).not.toContain("score 0-15");
    expect(prompt).not.toContain("score 0-20");
    expect(prompt).not.toContain("score 90-100");
    expect(prompt).not.toContain("score 70-100");
  });
});