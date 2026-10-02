import { describe, it, expect } from "vitest";

const { buildEvaluationBrief } = await import("@/lib/evaluation/prompt-builder");
const { buildSubmitEvaluationScoresTool } = await import("@/lib/evaluation/runtime-tools");
type AssertionSpec = import("@/lib/assertions").AssertionSpec;

describe("buildEvaluationBrief — Dynamic LLM Checklist", () => {
  it("formats expectation, unexpectation, and reference checklist items", () => {
    const assertions: AssertionSpec[] = [
      {
        type: "llm_custom",
        expectation: "Accurately name the poem as 望庐山瀑布",
      },
      {
        type: "llm_custom",
        unexpectation: "Mention unrelated poems like 静夜思",
      },
      {
        type: "llm_custom",
        reference: "日照香炉生紫烟，遥看瀑布挂前川。飞流直下三千尺，疑是银河落九天。",
      },
    ];

    const brief = buildEvaluationBrief({
      assertions,
      conversationText: "User: 请背诵庐山瀑布的诗\n\nAgent: 日照香炉生紫烟...",
    });

    expect(brief).toContain("EVALUATION ATOMIC CHECKLIST");
    expect(brief).toContain("[CHECK ITEM 0] CUSTOM SPECIFICATION:");
    expect(brief).toContain('Expectation (Required): "Accurately name the poem as 望庐山瀑布"');
    expect(brief).toContain("[CHECK ITEM 1] CUSTOM SPECIFICATION:");
    expect(brief).toContain('Forbidden (Must Avoid): "Mention unrelated poems like 静夜思"');
    expect(brief).toContain("[CHECK ITEM 2] CUSTOM SPECIFICATION:");
    expect(brief).toContain('Ground Truth Reference: "日照香炉生紫烟，遥看瀑布挂前川。飞流直下三千尺，疑是银河落九天。"');
    expect(brief).toContain("item_scores: Array with one entry for each of the 3 check items above");
    expect(brief).toContain("call `submit_evaluation_scores` EXACTLY ONCE");
  });
});

describe("buildSubmitEvaluationScoresTool", () => {
  it("validates and accepts item_scores in tool execution", async () => {
    const tool = buildSubmitEvaluationScoresTool();

    const result = (await tool.execute?.({
      item_scores: [
        { index: 0, score: 5, reason: "Accurately named poem." },
        { index: 1, score: 5, reason: "No unrelated poems mentioned." },
        { index: 2, score: 4, reason: "Matches reference context." },
      ],
      feedback: "Great job across all criteria.",
    })) as import("@/lib/evaluation/runtime-tools").SubmitEvaluationScoresSuccess;

    expect(result).toBeDefined();
    expect(result.ok).toBe(true);
    if (result && result.ok) {
      expect(result.item_scores).toHaveLength(3);
      expect(result.item_scores[0].score).toBe(5);
      expect(result.item_scores[1].reason).toBe("No unrelated poems mentioned.");
      expect(result.feedback).toBe("Great job across all criteria.");
    }
  });
});
