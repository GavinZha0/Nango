import { describe, it, expect } from "vitest";

import { runDeterministicChecks } from "@/lib/evaluation/deterministic-checks";
import { determineCaseVerdict } from "@/lib/assertions/verdict-engine.server";
import type { AssertionSpec } from "@/lib/assertions";

const dummyMetrics = {
  durationMs: 1200,
  outputTokens: 45,
  toolCallCount: 0,
};

describe("Evaluation Hybrid Assertions Scoring", () => {
  it("computes deterministic checks and partitions atomic LLM custom checks", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$.status",
        expected: "success",
      },
      {
        type: "llm_custom",
        expectation: "Clear explanation of turnaround time",
      },
      {
        type: "llm_custom",
        unexpectation: "Mentioning sensitive internal credentials",
      },
      {
        type: "llm_custom",
        reference: "Standard processing time is 1-3 business days",
      },
    ];

    const result = runDeterministicChecks(assertions, {
      agentText: '{"status": "success", "message": "1-3 days"}',
      structuredPayload: { status: "success", message: "1-3 days" },
      actualToolCalls: [],
      metrics: dummyMetrics,
    });

    expect(result.totalCount).toBe(1);
    expect(result.passedCount).toBe(1);
    expect(result.passRate).toBe(1);
    expect(result.assertionResults).toHaveLength(1);
    expect(result.assertionResults[0].ok).toBe(true);
    expect(result.llmAssertions).toHaveLength(3);
  });

  it("determines passed verdict when all deterministic pass and min(LLM scores) >= threshold", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$.status",
        expected: "success",
      },
      {
        type: "llm_dim",
        dim: "task-completion",
      },
      {
        type: "llm_custom",
        expectation: "Must include refund steps",
      },
    ];

    const checks = runDeterministicChecks(assertions, {
      agentText: '{"status": "success"}',
      structuredPayload: { status: "success" },
      actualToolCalls: [],
      metrics: dummyMetrics,
    });

    const verdict = determineCaseVerdict({
      assertions,
      deterministicResults: checks.assertionResults,
      llmScores: [
        { index: 1, score: 4, reason: "Task was fully completed." },
        { index: 2, score: 3, reason: "Refund steps are adequately mentioned." },
      ],
      threshold: 3,
      evaluatorFeedback: "Good response overall.",
    });

    expect(verdict.status).toBe("passed");
    expect(verdict.feedback).toBe("Good response overall.");
    expect(verdict.assertionResults).toHaveLength(3);
    expect(verdict.assertionResults[0].ok).toBe(true);
    expect(verdict.assertionResults[1].ok).toBe(true);
    expect(verdict.assertionResults[1].score).toBe(4);
    expect(verdict.assertionResults[2].ok).toBe(true);
    expect(verdict.assertionResults[2].score).toBe(3);
  });

  it("determines failed verdict when any LLM score < threshold", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$.status",
        expected: "success",
      },
      {
        type: "llm_dim",
        dim: "safety",
      },
    ];

    const checks = runDeterministicChecks(assertions, {
      agentText: '{"status": "success"}',
      structuredPayload: { status: "success" },
      actualToolCalls: [],
      metrics: dummyMetrics,
    });

    const verdict = determineCaseVerdict({
      assertions,
      deterministicResults: checks.assertionResults,
      llmScores: [
        { index: 1, score: 2, reason: "Violated safety guidelines." },
      ],
      threshold: 3,
      evaluatorFeedback: "Safety check failed.",
    });

    expect(verdict.status).toBe("failed");
    expect(verdict.assertionResults[1].ok).toBe(false);
    expect(verdict.assertionResults[1].score).toBe(2);
  });

  it("short-circuits with failed and marks LLM items skipped when deterministic assertion fails", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$.status",
        expected: "success",
      },
      {
        type: "llm_dim",
        dim: "task-completion",
      },
    ];

    const checks = runDeterministicChecks(assertions, {
      agentText: '{"status": "failure"}',
      structuredPayload: { status: "failure" },
      actualToolCalls: [],
      metrics: dummyMetrics,
    });

    const verdict = determineCaseVerdict({
      assertions,
      deterministicResults: checks.assertionResults,
      threshold: 3,
    });

    expect(verdict.status).toBe("failed");
    expect(verdict.assertionResults).toHaveLength(2);
    expect(verdict.assertionResults[0].ok).toBe(false);
    expect(verdict.assertionResults[1].ok).toBe(false);
    expect(verdict.assertionResults[1].skipped).toBe(true);
  });
});
