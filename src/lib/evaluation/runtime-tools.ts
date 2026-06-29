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

/** Maximum number of scored dimensions per call. Prevents a
 *  runaway evaluator from submitting thousands of entries. */
const MAX_DIMENSION_ENTRIES = 20;

const dimensionScoreEntry = z.object({
  id: z
    .string()
    .min(1)
    .describe("Dimension ID exactly as listed in the evaluation brief (e.g. 'faithfulness', 'tool-correctness')."),
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Score for this dimension (0 = worst, 100 = best)."),
  justification: z
    .string()
    .min(1)
    .describe("One-sentence justification for this dimension score."),
});

export const submitEvaluationScoresSchema = z.object({
  baseline_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "Overall baseline score (0–100) covering the three universal " +
      "criteria: Task Completion, Safety & Compliance, Basic Fluency. " +
      "Weight all three equally unless the evaluation brief says otherwise.",
    ),
  dimension_scores: z
    .array(dimensionScoreEntry)
    .max(MAX_DIMENSION_ENTRIES)
    .optional()
    .describe(
      "Per-dimension scores. Include one entry per dimension listed " +
      "in the evaluation brief. Omit this field entirely if no " +
      "specialized dimensions were requested.",
    ),
  criteria_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Score (0–100) for the case-level criteria (expectation). " +
      "Evaluate how well the agent's actual output matches the " +
      "expected behaviour described in the Expectation section of " +
      "the evaluation brief. Also consider the deterministic check " +
      "results provided (keywords, tool calls, assertions) — " +
      "failures there indicate the output did not meet concrete " +
      "requirements. Omit if no expectation was provided.",
    ),
  feedback: z
    .string()
    .min(1)
    .describe(
      "Concise overall evaluation summary (2–5 sentences). " +
      "Highlight key strengths, weaknesses, and any critical issues.",
    ),
});

export type SubmitEvaluationScoresArgs = z.infer<
  typeof submitEvaluationScoresSchema
>;

// ─── Result envelope ────────────────────────────────────────────────

export interface SubmitEvaluationScoresSuccess {
  ok: true;
  baseline_score: number;
  dimension_scores: Record<string, number>;
  /** LLM-judged expectation score (0-100). `null` when no
   *  expectation was provided in the case criteria. */
  criteria_score: number | null;
  feedback: string;
}

export interface SubmitEvaluationScoresFailure {
  ok: false;
  error:
    | "UNEXPECTED_DIMENSIONS"
    | "MISSING_DIMENSIONS"
    | "SCORE_OUT_OF_RANGE";
  message: string;
}

export type SubmitEvaluationScoresResult =
  | SubmitEvaluationScoresSuccess
  | SubmitEvaluationScoresFailure;

// ─── Tool builder ───────────────────────────────────────────────────

/**
 * Build the `submit_evaluation_scores` tool definition.
 *
 * @param opts.expectedDimensionIds — dimension IDs the evaluator is
 *   expected to score (from the suite's `dimension_ids`).
 *   Empty array means baseline-only.
 */
export function buildSubmitEvaluationScoresTool(opts: {
  expectedDimensionIds: readonly string[];
}): ToolDefinition {
  const expected = new Set(opts.expectedDimensionIds);

  return defineTool({
    name: "submit_evaluation_scores",
    description:
      "Submit your evaluation scores. Call this tool EXACTLY ONCE " +
      "after you have finished analysing the conversation. " +
      "Include baseline_score (always required) and one entry per " +
      "dimension listed in the evaluation brief. Do NOT invent " +
      "dimensions that were not requested.",
    parameters: submitEvaluationScoresSchema,
    execute: async (
      args: SubmitEvaluationScoresArgs,
    ): Promise<SubmitEvaluationScoresResult> => {
      const submitted = args.dimension_scores ?? [];

      // Validate: no unexpected dimension IDs.
      const submittedIds = new Set(submitted.map((d) => d.id));
      const unexpected = [...submittedIds].filter((id) => !expected.has(id));
      if (unexpected.length > 0) {
        return {
          ok: false,
          error: "UNEXPECTED_DIMENSIONS",
          message:
            `Unexpected dimension IDs: ${unexpected.join(", ")}. ` +
            `Only score the dimensions listed in the evaluation brief.`,
        };
      }

      // Validate: all expected dimensions present (when any were requested).
      if (expected.size > 0) {
        const missing = [...expected].filter((id) => !submittedIds.has(id));
        if (missing.length > 0) {
          return {
            ok: false,
            error: "MISSING_DIMENSIONS",
            message:
              `Missing dimension scores: ${missing.join(", ")}. ` +
              `Score every dimension listed in the evaluation brief.`,
          };
        }
      }

      // Flatten to Record<string, number> for storage.
      const dimensionScores: Record<string, number> = {};
      for (const entry of submitted) {
        dimensionScores[entry.id] = entry.score;
      }

      return {
        ok: true,
        baseline_score: args.baseline_score,
        dimension_scores: dimensionScores,
        criteria_score: args.criteria_score ?? null,
        feedback: args.feedback,
      };
    },
  });
}
