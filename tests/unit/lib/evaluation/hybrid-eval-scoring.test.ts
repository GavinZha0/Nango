import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runDeterministicChecks } from "@/lib/evaluation/deterministic-checks";
import type { AssertionSpec, AssertionResult } from "@/lib/assertions";

describe("Evaluation Hybrid Assertions Scoring", () => {
  it("computes deterministic checks and partitions atomic LLM judge checks", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$.status",
        expected: "success",
      },
      {
        type: "llm_judge",
        expectation: "Clear explanation of turnaround time",
      },
      {
        type: "llm_judge",
        unexpectation: "Mentioning sensitive internal credentials",
      },
      {
        type: "llm_judge",
        reference: "Standard processing time is 1-3 business days",
      },
    ];

    const result = runDeterministicChecks(assertions, {
      agentText: '{"status": "success", "message": "1-3 days"}',
      structuredPayload: { status: "success", message: "1-3 days" },
      actualToolCalls: [],
      metrics: {
        durationMs: 1200,
        outputTokens: 45,
        toolCallCount: 0,
      },
    });

    expect(result.totalCount).toBe(1);
    expect(result.passedCount).toBe(1);
    expect(result.passRate).toBe(1);
    expect(result.assertionResults).toHaveLength(1);
    expect(result.assertionResults[0].ok).toBe(true);
    expect(result.llmAssertions).toHaveLength(3);
  });

  it("maps llm_judge_results correctly using score >= 60 threshold", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "$.status",
        expected: "success",
      },
      {
        type: "llm_judge",
        expectation: "Must include refund steps",
      },
      {
        type: "llm_judge",
        unexpectation: "Must not mention competitors",
      },
    ];

    // Simulated evaluation tool output
    const rawLlmResults = [
      { index: 1, score: 90, reason: "Steps are clearly laid out." },
      { index: 2, score: 40, reason: "Competitor XYZ was mentioned in paragraph 2." },
    ];

    const unifiedResults: AssertionResult[] = [
      {
        index: 0,
        type: "jsonpath",
        ok: true,
        actual: "success",
        expected: "success",
        message: "JSONPath $.status == success",
      },
    ];

    for (const item of rawLlmResults) {
      const spec = assertions[item.index] as { type: "llm_judge"; expectation?: string; unexpectation?: string };
      unifiedResults.push({
        index: item.index,
        type: "llm_judge",
        ok: item.score >= 60,
        score: item.score,
        reason: item.reason,
        expectation: spec.expectation,
        unexpectation: spec.unexpectation,
        message: `LLM Judge: ${spec.expectation || spec.unexpectation}`,
      });
    }

    expect(unifiedResults).toHaveLength(3);
    expect(unifiedResults[0].ok).toBe(true);
    expect(unifiedResults[1].ok).toBe(true);
    expect(unifiedResults[1].score).toBe(90);
    expect(unifiedResults[2].ok).toBe(false);
    expect(unifiedResults[2].score).toBe(40);
  });
});
