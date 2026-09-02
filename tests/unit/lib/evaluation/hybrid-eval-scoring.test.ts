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

  it("handles out-of-order llm_judge_results by matching index accurately", () => {
    const EVAL_THRESHOLD_PASS = 60;
    const checks = {
      llmAssertions: [
        { index: 0, spec: { type: "llm_judge" as const, expectation: "Deliver conclusion first" } },
        { index: 1, spec: { type: "llm_judge" as const, unexpectation: "Do not invent facts" } },
        { index: 2, spec: { type: "llm_judge" as const, reference: "Reference truth statement" } },
      ],
    };

    // Evaluator returned items in reverse/scrambled order (index: 2, 0, 1)
    const scores = {
      baseline_score: 80,
      criteria_score: 75,
      feedback: "Overall good.",
      llm_judge_results: [
        { index: 2, score: 95, reason: "Reference strictly respected." },
        { index: 0, score: 85, reason: "Conclusion delivered up-front." },
        { index: 1, score: 50, reason: "Invented minor fact in middle." },
      ],
    };

    const unifiedAssertionResults: AssertionResult[] = [];
    const llmJudgeScoresList: number[] = [];

    for (let i = 0; i < checks.llmAssertions.length; i++) {
      const item = checks.llmAssertions[i];
      const originalIndex = item.index;
      const spec = item.spec;

      const itemResult =
        scores.llm_judge_results?.find((r) => r.index === i) ??
        scores.llm_judge_results?.[i] ??
        scores.llm_judge_results?.find((r) => r.index === originalIndex);

      const itemScore =
        itemResult?.score ?? scores.criteria_score ?? scores.baseline_score;
      const itemOk = itemScore >= EVAL_THRESHOLD_PASS;
      const itemReason = itemResult?.reason || scores.feedback;

      llmJudgeScoresList.push(itemScore);

      unifiedAssertionResults.push({
        index: originalIndex,
        type: "llm_judge",
        ok: itemOk,
        score: itemScore,
        reason: itemReason,
        feedback: itemReason,
        expectation: spec.expectation,
        unexpectation: spec.unexpectation,
        reference: spec.reference,
      });
    }

    // Verify correct mapping despite out-of-order return
    expect(unifiedAssertionResults).toHaveLength(3);
    // Item 0 (Expectation) -> score 85, pass
    expect(unifiedAssertionResults[0].index).toBe(0);
    expect(unifiedAssertionResults[0].score).toBe(85);
    expect(unifiedAssertionResults[0].ok).toBe(true);
    expect(unifiedAssertionResults[0].reason).toBe("Conclusion delivered up-front.");

    // Item 1 (Unexpectation) -> score 50, fail
    expect(unifiedAssertionResults[1].index).toBe(1);
    expect(unifiedAssertionResults[1].score).toBe(50);
    expect(unifiedAssertionResults[1].ok).toBe(false);
    expect(unifiedAssertionResults[1].reason).toBe("Invented minor fact in middle.");

    // Item 2 (Reference) -> score 95, pass
    expect(unifiedAssertionResults[2].index).toBe(2);
    expect(unifiedAssertionResults[2].score).toBe(95);
    expect(unifiedAssertionResults[2].ok).toBe(true);
    expect(unifiedAssertionResults[2].reason).toBe("Reference strictly respected.");
  });

  it("gracefully falls back to criteria_score / baseline_score when items are missing from submission", () => {
    const EVAL_THRESHOLD_PASS = 60;
    const checks = {
      llmAssertions: [
        { index: 1, spec: { type: "llm_judge" as const, expectation: "Accurate summary" } },
        { index: 3, spec: { type: "llm_judge" as const, unexpectation: "No hallucinated URLs" } },
      ],
    };

    // Evaluator only returned item 0 (matching first llm assertion), item 1 is omitted
    const scores = {
      baseline_score: 70,
      criteria_score: 65,
      feedback: "Partial evaluation available.",
      llm_judge_results: [
        { index: 0, score: 90, reason: "Summary is crisp." },
      ],
    };

    const unifiedAssertionResults: AssertionResult[] = [];

    for (let i = 0; i < checks.llmAssertions.length; i++) {
      const item = checks.llmAssertions[i];
      const originalIndex = item.index;
      const spec = item.spec;

      const itemResult =
        scores.llm_judge_results?.find((r) => r.index === i) ??
        scores.llm_judge_results?.[i] ??
        scores.llm_judge_results?.find((r) => r.index === originalIndex);

      const itemScore =
        itemResult?.score ?? scores.criteria_score ?? scores.baseline_score;
      const itemOk = itemScore >= EVAL_THRESHOLD_PASS;
      const itemReason = itemResult?.reason || scores.feedback;

      unifiedAssertionResults.push({
        index: originalIndex,
        type: "llm_judge",
        ok: itemOk,
        score: itemScore,
        reason: itemReason,
        feedback: itemReason,
        expectation: spec.expectation,
        unexpectation: spec.unexpectation,
      });
    }

    expect(unifiedAssertionResults).toHaveLength(2);
    // First assertion (i=0) got explicit score 90
    expect(unifiedAssertionResults[0].index).toBe(1);
    expect(unifiedAssertionResults[0].score).toBe(90);
    expect(unifiedAssertionResults[0].reason).toBe("Summary is crisp.");

    // Second assertion (i=1) was omitted by evaluator; fell back to criteria_score 65 and overall feedback
    expect(unifiedAssertionResults[1].index).toBe(3);
    expect(unifiedAssertionResults[1].score).toBe(65);
    expect(unifiedAssertionResults[1].ok).toBe(true); // 65 >= 60
    expect(unifiedAssertionResults[1].reason).toBe("Partial evaluation available.");
  });

  it("handles fallback to originalIndex if evaluator returns absolute assertion indices", () => {
    const EVAL_THRESHOLD_PASS = 60;
    // Two LLM assertions with absolute indices 2 and 5 in the full suite
    const checks = {
      llmAssertions: [
        { index: 2, spec: { type: "llm_judge" as const, expectation: "Answer is concise" } },
        { index: 5, spec: { type: "llm_judge" as const, reference: "Exact quote from context" } },
      ],
    };

    // Evaluator returned results with original absolute index (2 and 5)
    const scores = {
      baseline_score: 80,
      criteria_score: 80,
      feedback: "All criteria evaluated.",
      llm_judge_results: [
        { index: 2, score: 88, reason: "Very concise." },
        { index: 5, score: 92, reason: "Quote matches perfectly." },
      ],
    };

    const unifiedAssertionResults: AssertionResult[] = [];

    for (let i = 0; i < checks.llmAssertions.length; i++) {
      const item = checks.llmAssertions[i];
      const originalIndex = item.index;
      const spec = item.spec;

      const itemResult =
        scores.llm_judge_results?.find((r) => r.index === i) ??
        scores.llm_judge_results?.[i] ??
        scores.llm_judge_results?.find((r) => r.index === originalIndex);

      const itemScore =
        itemResult?.score ?? scores.criteria_score ?? scores.baseline_score;
      const itemOk = itemScore >= EVAL_THRESHOLD_PASS;
      const itemReason = itemResult?.reason || scores.feedback;

      unifiedAssertionResults.push({
        index: originalIndex,
        type: "llm_judge",
        ok: itemOk,
        score: itemScore,
        reason: itemReason,
        expectation: spec.expectation,
        reference: spec.reference,
      });
    }

    expect(unifiedAssertionResults).toHaveLength(2);
    expect(unifiedAssertionResults[0].index).toBe(2);
    expect(unifiedAssertionResults[0].score).toBe(88);
    expect(unifiedAssertionResults[0].reason).toBe("Very concise.");

    expect(unifiedAssertionResults[1].index).toBe(5);
    expect(unifiedAssertionResults[1].score).toBe(92);
    expect(unifiedAssertionResults[1].reason).toBe("Quote matches perfectly.");
  });
});
