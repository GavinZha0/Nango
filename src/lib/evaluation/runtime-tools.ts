/**
 * Server-side `submit_evaluation_scores` agent tool.
 *
 * Injected exclusively into evaluator agents (`role = 'evaluator'`)
 * during programmatic dispatch. The evaluator calls this tool once
 * at the end of its analysis to return structured scores. The
 * evaluation runner reads the tool-call event from
 * `entity_run_event` after the dispatch completes.
 *
 * Design rationale: tool calls are natively structured (JSON args
 * validated by Zod), making score extraction deterministic.
 * Alternatives (regex on free-text, JSON-in-markdown) are fragile
 * and model-dependent.
 *
 * See docs/evaluation.md.
 */

import "server-only";

import { z } from "zod";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";

// ─── Schema ─────────────────────────────────────────────────────────

export const itemScoreEntrySchema = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .describe(
      "0-based index matching [CHECK ITEM 0], [CHECK ITEM 1], etc. as specified in the evaluation brief.",
    ),
  score: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      "Discrete Likert score for this item on a 1-5 scale: " +
      "1 = Complete Failure / Dangerous / Hallucinated, " +
      "2 = Marginal / Substandard, " +
      "3 = Acceptable (Pass threshold), " +
      "4 = Good, " +
      "5 = Excellent / Flawless.",
    ),
  reason: z
    .string()
    .min(1)
    .describe("Concise reason citing specific evidence from conversation/output."),
});

export const submitEvaluationScoresSchema = z.object({
  item_scores: z
    .array(itemScoreEntrySchema)
    .describe(
      "Per-item scores for all checklist items listed in the evaluation brief. " +
      "Include exactly one entry per check item, matching indices.",
    ),
  feedback: z
    .string()
    .min(1)
    .describe(
      "Concise overall evaluation summary (2–5 sentences) highlighting key strengths, " +
      "weaknesses, and general observations.",
    ),
});

export type SubmitEvaluationScoresArgs = z.infer<
  typeof submitEvaluationScoresSchema
>;

// ─── Result envelope ────────────────────────────────────────────────

export interface SubmitEvaluationScoresSuccess {
  ok: true;
  item_scores: Array<{
    index: number;
    score: number;
    reason: string;
  }>;
  feedback: string;
}

export type SubmitEvaluationScoresResult = SubmitEvaluationScoresSuccess;

// ─── Tool builder ───────────────────────────────────────────────────

/**
 * Build the `submit_evaluation_scores` tool definition.
 */
export function buildSubmitEvaluationScoresTool(): ToolDefinition {
  return defineTool({
    name: "submit_evaluation_scores",
    description:
      "Submit your evaluation scores. Call this tool EXACTLY ONCE " +
      "after you have finished analysing the conversation / execution output. " +
      "Submit all item_scores together (1-5 Likert scale) along with overall feedback. " +
      "Do NOT output plain text.",
    parameters: submitEvaluationScoresSchema,
    execute: async (
      args: SubmitEvaluationScoresArgs,
    ): Promise<SubmitEvaluationScoresResult> => {
      return {
        ok: true,
        item_scores: args.item_scores,
        feedback: args.feedback,
      };
    },
  });
}
