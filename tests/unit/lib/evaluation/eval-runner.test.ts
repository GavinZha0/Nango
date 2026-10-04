import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EntityRunEventEntity } from "@/lib/db/schema";

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

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfigNumber: (...args: unknown[]) => mockGetConfigNumber(...args),
  };
});

const { runEvalCase, analyzeToolCallEvents } = await import("@/lib/evaluation/eval-runner");

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
  it("short-circuits before target dispatch when case selects dimensions without an evaluator", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [
          { type: "llm_dim", dim: "faithfulness" },
        ],
      }),
    );

    expect(result.status).toBe("errored");
    expect(mockRunnerStart).not.toHaveBeenCalled();
    expect(mockWriteCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "errored", error: expect.objectContaining({ source: "config" }) }),
    );
  });

  it("short-circuits before target dispatch for judge-only cases without an evaluator", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [{ type: "llm_custom", expectation: "Clear and safe answer" }],
      }),
    );

    expect(result.status).toBe("errored");
    expect(mockRunnerStart).not.toHaveBeenCalled();

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("llm_custom");
    expect(row.ok).toBe(false);
    expect(row.skipped).toBe(true);
    expect(row.score).toBeUndefined();
  });

  it("runs deterministic checks but errors (not passes) when mixed deterministic+judge case has no evaluator and deterministics pass", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [
          { type: "js_expression", expression: "true" },
          { type: "llm_custom", expectation: "Clear and safe answer" },
        ],
      }),
    );

    expect(result.status).toBe("errored");
    expect(mockRunnerStart).toHaveBeenCalledTimes(1); // target dispatched, judge not

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(2);
    const deterministic = rows.find((r) => r.type === "js_expression");
    const llm = rows.find((r) => r.type === "llm_custom");
    expect(deterministic?.ok).toBe(true);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.score).toBeUndefined();
    expect(result.feedback).toContain("no evaluator agent is configured");
  });

  it("fails on deterministic assertions even without an evaluator, marking judge rows skipped (1:1 index kept)", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [
          { type: "js_expression", expression: "false" },
          { type: "llm_custom", expectation: "Clear and safe answer" },
        ],
      }),
    );

    expect(result.status).toBe("failed");

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(2);
    const deterministic = rows.find((r) => r.type === "js_expression");
    const llm = rows.find((r) => r.type === "llm_custom");
    expect(deterministic?.ok).toBe(false);
    expect(llm?.ok).toBe(false);
    expect(llm?.skipped).toBe(true);
    expect(llm?.reason).toContain("Skipped: deterministic");
    expect(llm?.score).toBeUndefined();

    expect(mockWriteCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("keeps pure-deterministic suites passing when no evaluator and no dimensions are configured", async () => {
    const result = await runEvalCase(
      makeInput({
        assertions: [{ type: "js_expression", expression: "true" }],
      }),
    );

    expect(result.status).toBe("passed");
    expect(mockRunnerStart).toHaveBeenCalledTimes(1);
    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(mockWriteCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "passed" }),
    );
  });

  it("errors with skipped judge rows when an evaluator is configured but never submits scores", async () => {
    const result = await runEvalCase(
      makeInput({
        evaluatorAgentId: "eval-1",
        assertions: [
          { type: "js_expression", expression: "true" },
          { type: "llm_custom", expectation: "Clear and safe answer" },
        ],
      }),
    );

    // 1 target dispatch + 2 evaluator retries
    expect(mockRunnerStart).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("errored");
    expect(result.error).toContain("Evaluator did not call submit_evaluation_scores");

    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(2);
    const deterministic = rows.find((r) => r.type === "js_expression");
    const llm = rows.find((r) => r.type === "llm_custom");
    expect(deterministic?.ok).toBe(true);
    expect(llm?.ok).toBe(false);
    expect(llm?.reason).toContain("Evaluator failed");
  });

  it("remaps 0-based relative checklist scores back to interleaved assertion indices and retains self-contained metadata", async () => {
    mockReadEvents
      .mockResolvedValueOnce([]) // for target agent
      .mockResolvedValueOnce([   // for evaluator agent
        {
          type: "tool_call_chunk",
          payload: {
            toolName: "submit_evaluation_scores",
            args: JSON.stringify({
              item_scores: [
                { index: 0, score: 5, reason: "First LLM item passed" },
                { index: 1, score: 4, reason: "Second LLM item passed" },
              ],
              feedback: "Overall good performance.",
            }),
          },
        },
      ]);

    const result = await runEvalCase(
      makeInput({
        evaluatorAgentId: "eval-1",
        assertions: [
          { type: "js_expression", expression: "true" }, // index 0 (deterministic)
          { type: "llm_custom", expectation: "Clear and safe answer" }, // index 1 (LLM)
          { type: "metric", metric: "duration_s", operator: "<", threshold: 10 }, // index 2 (deterministic)
          { type: "llm_dim", dim: "safety" }, // index 3 (LLM)
        ],
      }),
    );

    expect(result.status).toBe("passed");
    const rows = result.assertionResults ?? [];
    expect(rows).toHaveLength(4);

    // Row 0: js_expression
    expect(rows[0].index).toBe(0);
    expect(rows[0].type).toBe("js_expression");
    expect(rows[0].ok).toBe(true);
    expect(rows[0].expression).toBe("true");

    // Row 1: llm_custom (remapped from relative index 0)
    expect(rows[1].index).toBe(1);
    expect(rows[1].type).toBe("llm_custom");
    expect(rows[1].ok).toBe(true);
    expect(rows[1].score).toBe(5);
    expect(rows[1].reason).toBe("First LLM item passed");
    expect(rows[1].expectation).toBe("Clear and safe answer");

    // Row 2: metric
    expect(rows[2].index).toBe(2);
    expect(rows[2].type).toBe("metric");
    expect(rows[2].ok).toBe(true);
    expect(rows[2].metric).toBe("duration_s");

    // Row 3: llm_dim (remapped from relative index 1)
    expect(rows[3].index).toBe(3);
    expect(rows[3].type).toBe("llm_dim");
    expect(rows[3].ok).toBe(true);
    expect(rows[3].score).toBe(4);
    expect(rows[3].reason).toBe("Second LLM item passed");
    expect(rows[3].dim).toBe("safety");
    expect(result.toolCallSummary).toBeDefined();
    expect(result.toolCallSummary?.totalCalls).toBe(0);
  });
});

describe("analyzeToolCallEvents", () => {
  it("correctly audits success, failure, and POLICY_DENIED blocked tool calls", () => {
    const events: EntityRunEventEntity[] = [
      // 1. Success tool call
      {
        runId: "r1",
        seq: 1,
        type: "tool_call_chunk",
        ts: new Date("2026-10-02T12:00:01Z"),
        payload: { toolCallId: "call_1", toolName: "read_file" },
      },
      {
        runId: "r1",
        seq: 2,
        type: "tool_call_result",
        ts: new Date("2026-10-02T12:00:02Z"),
        payload: { toolCallId: "call_1", content: JSON.stringify({ content: "hello world" }) },
      },
      // 2. Failed tool call
      {
        runId: "r1",
        seq: 3,
        type: "tool_call_chunk",
        ts: new Date("2026-10-02T12:00:03Z"),
        payload: { toolCallId: "call_2", toolName: "extract_dataset_by_sql" },
      },
      {
        runId: "r1",
        seq: 4,
        type: "tool_call_result",
        ts: new Date("2026-10-02T12:00:04Z"),
        payload: {
          toolCallId: "call_2",
          content: JSON.stringify({ isError: true, message: "Database connection timed out" }),
        },
      },
      // 3. Blocked tool call (POLICY_DENIED via G20 Headless Deny)
      {
        runId: "r1",
        seq: 5,
        type: "tool_call_chunk",
        ts: new Date("2026-10-02T12:00:05Z"),
        payload: { toolCallId: "call_3", toolName: "run_ssh_command" },
      },
      {
        runId: "r1",
        seq: 6,
        type: "tool_call_result",
        ts: new Date("2026-10-02T12:00:06Z"),
        payload: {
          toolCallId: "call_3",
          content: JSON.stringify({
            isError: true,
            toolName: "run_ssh_command",
            code: "POLICY_DENIED",
            message: "Headless execution denied by policy",
          }),
        },
      },
      // 4. Repeated tool call (second run_ssh_command, also blocked)
      {
        runId: "r1",
        seq: 7,
        type: "tool_call_chunk",
        ts: new Date("2026-10-02T12:00:07Z"),
        payload: { toolCallId: "call_4", toolName: "run_ssh_command" },
      },
      {
        runId: "r1",
        seq: 8,
        type: "tool_call_result",
        ts: new Date("2026-10-02T12:00:08Z"),
        payload: {
          toolCallId: "call_4",
          content: JSON.stringify({
            isError: true,
            toolName: "run_ssh_command",
            code: "POLICY_DENIED",
            message: "Headless execution denied by policy",
          }),
        },
      },
    ];

    const summary = analyzeToolCallEvents(events);

    expect(summary.totalCalls).toBe(4);
    expect(summary.failureCount).toBe(1);
    expect(summary.blockedCount).toBe(2);
    expect(summary.totalDurationMs).toBe(4000);
    expect(summary.toolDurations).toEqual({
      read_file: 1000,
      extract_dataset_by_sql: 1000,
      run_ssh_command: 2000,
    });
    expect(summary.toolFrequency).toEqual({
      read_file: 1,
      extract_dataset_by_sql: 1,
      run_ssh_command: 2,
    });
    expect(summary.abnormalDetails).toHaveLength(3);

    // First abnormal detail: failed extract_dataset_by_sql
    expect(summary.abnormalDetails[0]).toEqual({
      toolName: "extract_dataset_by_sql",
      status: "failed",
      durationMs: 1000,
      code: undefined,
      reason: "Database connection timed out",
    });

    // Second abnormal detail: blocked run_ssh_command
    expect(summary.abnormalDetails[1]).toEqual({
      toolName: "run_ssh_command",
      status: "blocked",
      durationMs: 1000,
      code: "POLICY_DENIED",
      reason: "Headless execution denied by policy",
    });

    // Third abnormal detail: blocked run_ssh_command
    expect(summary.abnormalDetails[2]).toEqual({
      toolName: "run_ssh_command",
      status: "blocked",
      durationMs: 1000,
      code: "POLICY_DENIED",
      reason: "Headless execution denied by policy",
    });
  });

  it("preserves specific blocked code such as TOOL_HEADLESS_DENIED in abnormalDetails", () => {
    const events: EntityRunEventEntity[] = [
      {
        runId: "r1",
        seq: 1,
        type: "tool_call_chunk",
        ts: new Date("2026-10-02T12:00:01Z"),
        payload: { toolCallId: "call_1", toolName: "run_shell_script" },
      },
      {
        runId: "r1",
        seq: 2,
        type: "tool_call_result",
        ts: new Date("2026-10-02T12:00:02Z"),
        payload: {
          toolCallId: "call_1",
          content: JSON.stringify({
            isError: true,
            toolName: "run_shell_script",
            code: "TOOL_HEADLESS_DENIED",
            message: "Interactive confirmation denied in headless mode",
          }),
        },
      },
    ];

    const summary = analyzeToolCallEvents(events);
    expect(summary.blockedCount).toBe(1);
    expect(summary.abnormalDetails[0]).toEqual({
      toolName: "run_shell_script",
      status: "blocked",
      durationMs: 1000,
      code: "TOOL_HEADLESS_DENIED",
      reason: "Interactive confirmation denied in headless mode",
    });
  });
});

describe("runEvalCase — targetTimeoutSec override", () => {
  it("times out target agent turn when custom targetTimeoutSec is exceeded", async () => {
    mockRunnerStart.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: "succeeded" }), 100)),
    );

    const result = await runEvalCase({
      ...makeInput(),
      targetTimeoutSec: 0.01, // 10ms timeout
    });

    expect(result.status).toBe("errored");
    expect(result.error).toMatch(/timed out/i);
    expect(mockWriteCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "errored",
        error: expect.objectContaining({
          message: expect.stringMatching(/timed out/i),
        }),
      }),
    );
  });

  it("completes normally when target agent finishes within targetTimeoutSec", async () => {
    mockRunnerStart.mockResolvedValue({
      status: "succeeded",
      runId: "run-target",
      summary: "Completed quickly",
    });

    const result = await runEvalCase({
      ...makeInput(),
      targetTimeoutSec: 60,
    });

    expect(result.status).toBe("passed");
  });

  it("defaults to 300s fallback when targetTimeoutSec is not provided", async () => {
    mockRunnerStart.mockResolvedValue({
      status: "succeeded",
      runId: "run-target",
      summary: "Completed with default timeout",
    });

    const result = await runEvalCase(makeInput());
    expect(result.status).toBe("passed");
  });
});
