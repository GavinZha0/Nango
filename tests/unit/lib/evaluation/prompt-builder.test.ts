import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { buildEvaluationBrief } = await import("@/lib/evaluation/prompt-builder");
const { buildSubmitEvaluationScoresTool } = await import("@/lib/evaluation/runtime-tools");
type AssertionSpec = import("@/lib/assertions").AssertionSpec;

describe("buildEvaluationBrief — Atomic LLM Judge Checklist", () => {
  it("formats expectation, unexpectation, and reference checklist items", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "llm_judge",
        expectation: "Accurately name the poem as 望庐山瀑布",
      },
      {
        type: "llm_judge",
        unexpectation: "Mention unrelated poems like 静夜思",
      },
      {
        type: "llm_judge",
        reference: "日照香炉生紫烟，遥看瀑布挂前川。飞流直下三千尺，疑是银河落九天。",
      },
    ];

    const brief = buildEvaluationBrief({
      dimensionIds: ["faithfulness"],
      assertions,
      conversationText: "User: 请背诵庐山瀑布的诗\n\nAgent: 日照香炉生紫烟...",
    });

    expect(brief).toContain("LLM AS JUDGE ATOMIC CHECKLIST");
    expect(brief).toContain("Item #1 (Index: 0) [EXPECTATION]:");
    expect(brief).toContain('Target: "Accurately name the poem as 望庐山瀑布"');
    expect(brief).toContain("Item #2 (Index: 1) [UNEXPECTATION / FORBIDDEN]:");
    expect(brief).toContain('Target: "Mention unrelated poems like 静夜思"');
    expect(brief).toContain("Item #3 (Index: 2) [REFERENCE CONTEXT]:");
    expect(brief).toContain('Ground Truth: "日照香炉生紫烟，遥看瀑布挂前川。飞流直下三千尺，疑是银河落九天。"');
    expect(brief).toContain("llm_judge_results (array with one entry for each of the 3 check items above");
    expect(brief).toContain("call `submit_evaluation_scores` EXACTLY ONCE in a single tool call");
  });
});

describe("buildSubmitEvaluationScoresTool", () => {
  it("validates and accepts llm_judge_results in tool execution", async () => {
    const tool = buildSubmitEvaluationScoresTool({
      expectedDimensionIds: ["faithfulness"],
    });

    const result = (await tool.execute?.({
      baseline_score: 85,
      dimension_scores: [
        { id: "faithfulness", score: 90, justification: "Fully grounded." },
      ],
      llm_judge_results: [
        { index: 0, score: 95, reason: "Accurately named poem." },
        { index: 1, score: 100, reason: "No unrelated poems mentioned." },
        { index: 2, score: 90, reason: "Matches reference context." },
      ],
      feedback: "Great job across all criteria.",
    })) as import("@/lib/evaluation/runtime-tools").SubmitEvaluationScoresSuccess;

    expect(result).toBeDefined();
    expect(result.ok).toBe(true);
    if (result && result.ok) {
      expect(result.baseline_score).toBe(85);
      expect(result.dimension_scores.faithfulness).toBe(90);
      expect(result.llm_judge_results).toHaveLength(3);
      expect(result.llm_judge_results?.[0].score).toBe(95);
      expect(result.llm_judge_results?.[1].reason).toBe("No unrelated poems mentioned.");
    }
  });
});
