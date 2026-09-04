import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockRunnerStart, mockReadEvents, mockWriteCaseResult, mockGetConfigNumber } =
  vi.hoisted(() => ({
    mockRunnerStart: vi.fn(),
    mockReadEvents: vi.fn(),
    mockWriteCaseResult: vi.fn(),
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

vi.mock("@/lib/evaluation/storage", () => ({
  writeCaseResult: (...args: unknown[]) => mockWriteCaseResult(...args),
}));

vi.mock("@/lib/config", () => ({
  getConfigNumber: (...args: unknown[]) => mockGetConfigNumber(...args),
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runEvalCase } = await import("@/lib/evaluation/eval-runner");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfigNumber.mockResolvedValue(300);
  mockReadEvents.mockResolvedValue([]);
  mockRunnerStart.mockResolvedValue({
    status: "succeeded",
    runId: "run-target",
    summary: "Agent responded to the user.",
  });
});

interface RunCaseOverrides {
  evaluatorAgentId?: string | null;
  dimensionIds?: string[];
  assertions?: unknown[];
  turns?: Array<{ userMessage: string }>;
}

function makeInput(overrides: RunCaseOverrides = {}) {
  return {
    runId: "run-1",
    caseId: 42,
    targetAgentId: "agent-1",
    agentSource: "builtin" as const,
    evaluatorAgentId: overrides.evaluatorAgentId ?? null,
    dimensionIds: overrides.dimensionIds ?? [],
    turns: overrides.turns ?? [{ userMessage: "hello" }],
    assertions: (overrides.assertions ?? []) as never[],
    ownerId: "user-1",
  };
}

describe("runEvalCase — evaluator-not-configured semantics", () => {
  it("short-circuits before target dispatch when suite selects dimensions without an evaluator", async () => {
    const result = await runEvalCase(
      makeInput({
        dimensionIds: ["faithfulness"],
        assertions: [{ type: "js_expression", expression: "true" }],
      }),
    );

    expect(result.status).toBe("errored");
    expect(result.score).toBeNull();
    expect(mockRunnerStart).not.toHaveBeenCalled();
    expect(mockWriteCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "errored", error: expect.objectContaining({ source: "config" }) }),
    );
  });

  it("short-circuits before target dispatch for judge-only cases without an evaluator", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [{ type: "llm_judge", expectation: "Clear and safe answer" }],
      }),
    );

    expect(result.status).toBe("errored");
    expect(result.score).toBeNull();
    expect(mockRunnerStart).not.toHaveBeenCalled();

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("llm_judge");
    expect(row.ok).toBe(false);
    expect(row.skipped).toBe(true);
    expect(row.score).toBeUndefined();
  });

  it("runs deterministic checks but errors (not passes) when mixed deterministic+judge case has no evaluator and deterministics pass", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [
          { type: "js_expression", expression: "true" },
          { type: "llm_judge", expectation: "Clear and safe answer" },
        ],
      }),
    );

    expect(result.status).toBe("errored");
    expect(result.score).toBeNull();
    expect(mockRunnerStart).toHaveBeenCalledTimes(1); // target dispatched, judge not

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(2);
    const deterministic = rows.find((r) => r.type === "js_expression");
    const llm = rows.find((r) => r.type === "llm_judge");
    expect(deterministic?.ok).toBe(true);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.score).toBeUndefined();
    expect(result.feedback).toContain("Evaluator agent is not configured");
  });

  it("fails on deterministic assertions even without an evaluator, marking judge rows skipped (1:1 index kept)", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [
          { type: "js_expression", expression: "false" },
          { type: "llm_judge", expectation: "Clear and safe answer" },
        ],
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.score).toBe(0);

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(2);
    const deterministic = rows.find((r) => r.type === "js_expression");
    const llm = rows.find((r) => r.type === "llm_judge");
    expect(deterministic?.ok).toBe(false);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.reason).toContain("Skipped: deterministic");
    expect(llm?.score).toBeUndefined();

    expect(mockWriteCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", score: 0 }),
    );
  });

  it("keeps pure-deterministic suites passing at 100 when no evaluator and no dimensions are configured", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [{ type: "js_expression", expression: "true" }],
      }),
    );

    expect(result.status).toBe("passed");
    expect(result.score).toBe(100);
    expect(mockRunnerStart).toHaveBeenCalledTimes(1);
    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(mockWriteCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "passed", score: 100 }),
    );
  });

  it("errors with skipped judge rows when an evaluator is configured but never submits scores", async () => {
    const result = await runEvalCase(
      makeInput({
        evaluatorAgentId: "eval-1",
        assertions: [
          { type: "js_expression", expression: "true" },
          { type: "llm_judge", expectation: "Clear and safe answer" },
        ],
      }),
    );

    // 1 target dispatch + 2 evaluator retries
    expect(mockRunnerStart).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("errored");
    expect(result.score).toBeNull();
    expect(result.error).toContain("Evaluator did not call submit_evaluation_scores");

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(2);
    const deterministic = rows.find((r) => r.type === "js_expression");
    const llm = rows.find((r) => r.type === "llm_judge");
    expect(deterministic?.ok).toBe(true);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.reason).toContain("Evaluator failed");
  });
});
