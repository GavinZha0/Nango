/**
 * Evaluation — evaluator prompt assembler.
 *
 * Composes the full prompt sent to the evaluator agent at scoring
 * time. The prompt is assembled from multiple sources:
 *
 *   1. Evaluator system prompt (baseline criteria — always present)
 *   2. Suite dimension prompts (0–5 selected dimensions)
 *   3. Case criteria context (expectation, reference, assertions, …)
 *   4. Deterministic check results (code-verified, ✓/✗)
 *   5. Target agent conversation transcript
 *
 * The evaluator reads this assembled prompt and calls
 * `submit_evaluation_scores` once with structured scores.
 *
 * See docs/evaluation.md.
 */

import "server-only";

import {
  BUILTIN_DIMENSIONS,
  type EvalCriteria,
  type CriteriaCheckResult,
} from "./types";
import { formatChecksForPrompt } from "./deterministic-checks";

// ─── Input ──────────────────────────────────────────────────────────

export interface PromptBuilderInput {
  /** Evaluator agent's system prompt (user-editable, or
   *  DEFAULT_EVALUATOR_SYSTEM_PROMPT). Already set on the agent spec
   *  — this is the ADDITIONAL task prompt appended as the user
   *  message (evaluation brief). */
  dimensionIds: string[];
  criteria: EvalCriteria;
  /** Deterministic check results from `runDeterministicChecks`. */
  checkResults: CriteriaCheckResult[];
  /** Full conversation transcript (user + agent turns). */
  conversationText: string;
}

// ─── Builder ────────────────────────────────────────────────────────

/**
 * Assemble the evaluation brief — the user-message prompt sent to
 * the evaluator agent. The evaluator's system prompt (baseline
 * criteria + scoring method) is already set on the agent spec; this
 * function builds the per-case evaluation task.
 */
export function buildEvaluationBrief(input: PromptBuilderInput): string {
  const sections: string[] = [];

  // ── 1. Dimension prompts ──────────────────────────────────────

  if (input.dimensionIds.length > 0) {
    const dimBlocks: string[] = [];
    for (const dimId of input.dimensionIds) {
      const dim = BUILTIN_DIMENSIONS.find((d) => d.id === dimId);
      if (dim) dimBlocks.push(dim.prompt);
    }
    if (dimBlocks.length > 0) {
      sections.push(
        "SPECIALIZED DIMENSIONS\n" +
        "Score each dimension below independently (0-100). " +
        "Include one entry per dimension in your submission.\n\n" +
        dimBlocks.join("\n\n"),
      );
    }
  }

  // ── 2. Case criteria context ──────────────────────────────────

  const criteriaLines: string[] = [];

  if (input.criteria.expectation) {
    criteriaLines.push(`Expectation: ${input.criteria.expectation}`);
  }
  if (input.criteria.reference) {
    criteriaLines.push(`Reference answer: ${input.criteria.reference}`);
  }
  if (input.criteria.issue) {
    criteriaLines.push(`Reported issue: ${input.criteria.issue}`);
  }
  if (input.criteria.context && input.criteria.context.length > 0) {
    criteriaLines.push(
      `Supplementary context:\n${input.criteria.context.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`,
    );
  }
  if (input.criteria.assertions && input.criteria.assertions.length > 0) {
    criteriaLines.push(
      `Assertions (evaluate whether the output satisfies each):\n${input.criteria.assertions.map((a) => `  - ${a}`).join("\n")}`,
    );
  }

  if (criteriaLines.length > 0) {
    sections.push(
      "CASE CRITERIA\n" +
      "Use these as ground truth when scoring. The expectation " +
      "describes what the agent should have done; the reference is " +
      "the ideal answer; assertions are specific constraints to check.\n\n" +
      criteriaLines.join("\n\n"),
    );
  }

  // ── 3. Deterministic check results ────────────────────────────

  const checksBlock = formatChecksForPrompt(input.checkResults);
  if (checksBlock.length > 0) {
    sections.push(checksBlock);
  }

  // ── 4. Conversation transcript ────────────────────────────────

  sections.push(
    "CONVERSATION TO EVALUATE\n" +
    "The following is the complete conversation between the user and " +
    "the target agent. Evaluate it against the baseline criteria, " +
    (input.dimensionIds.length > 0 ? "specialized dimensions, " : "") +
    "and case criteria above.\n\n" +
    input.conversationText,
  );

  // ── 5. Scoring instructions ───────────────────────────────────

  const scoreItems = ["baseline_score (always required)"];
  if (input.dimensionIds.length > 0) {
    scoreItems.push(
      `dimension_scores (one entry for each: ${input.dimensionIds.join(", ")})`,
    );
  }
  if (input.criteria.expectation || input.criteria.assertions?.length) {
    scoreItems.push("criteria_score (how well the output matches the expectation and assertions)");
  }
  scoreItems.push("feedback (2-5 sentence summary)");

  sections.push(
    "INSTRUCTIONS\n" +
    "Analyse the conversation above, then call `submit_evaluation_scores` " +
    "exactly once with:\n" +
    scoreItems.map((s) => `  - ${s}`).join("\n") +
    "\n\nCRITICAL: You MUST use the `submit_evaluation_scores` tool to return your scores. Do not output normal text.",
  );

  return sections.join("\n\n---\n\n");
}
