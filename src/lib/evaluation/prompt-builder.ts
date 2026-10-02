/**
 * Evaluation — evaluator prompt assembler.
 *
 * Composes the full evaluation brief sent to the evaluator agent at scoring time.
 * Assembled from:
 *   1. Checklist of LLM items in the case (llm_dim and llm_custom).
 *   2. Rubrics from BUILTIN_EVAL_DIMENSIONS for any selected dimensions.
 *   3. Deterministic check results (code-verified, ✓/✗) so evaluator has context.
 *   4. Target agent conversation transcript.
 *
 * The evaluator reads this assembled prompt and calls
 * `submit_evaluation_scores` once with structured `item_scores` (1-5 scale) and `feedback`.
 *
 * See docs/evaluation.md.
 */

import "server-only";

import type {
  AssertionSpec,
  LlmCustomAssertion,
  LlmDimAssertion,
} from "@/lib/assertions";
import {
  BUILTIN_EVAL_DIMENSIONS,
  type CriteriaCheckResult,
} from "./types";
import { formatChecksForPrompt } from "./deterministic-checks";

export interface PromptBuilderInput {
  /** Optional suite-level dimension IDs (for backwards compatibility). */
  dimensionIds?: string[];
  /** Unified assertions list (deterministic + llm_dim + llm_custom). */
  assertions: readonly AssertionSpec[];
  /** Deterministic check results from code evaluation. */
  checkResults?: CriteriaCheckResult[];
  /** Full conversation transcript (user + agent turns). */
  conversationText: string;
}

/**
 * Assemble the evaluation brief sent to the evaluator agent.
 */
export function buildEvaluationBrief(input: PromptBuilderInput): string {
  const sections: string[] = [];

  // 1. LLM Check Items (llm_dim and llm_custom)
  const checklistBlocks: string[] = [];
  const checklistIndices: number[] = [];

  const assertions = input.assertions ?? [];
  let checkIndex = 0;
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];

    if (a.type === "llm_dim") {
      const dimSpec = a as LlmDimAssertion;
      const dim = BUILTIN_EVAL_DIMENSIONS.find((d) => d.id === dimSpec.dim);
      const itemHeader = `[CHECK ITEM ${checkIndex}]`;
      checklistIndices.push(checkIndex);
      checkIndex++;

      if (dim) {
        checklistBlocks.push(
          `${itemHeader} SPECIALIZED DIMENSION: ${dim.name}\n` +
          `Category: ${dim.category}\n` +
          `Description: ${dim.description}\n\n` +
          `EVALUATION GUIDELINES & RUBRIC:\n` +
          `${dim.prompt}`,
        );
      } else {
        checklistBlocks.push(
          `${itemHeader} SPECIALIZED DIMENSION: ${dimSpec.dim}\n` +
          `Evaluate the conversation for quality on the '${dimSpec.dim}' dimension on a 1-5 discrete scale.`,
        );
      }
    } else if (a.type === "llm_custom") {
      const customSpec = a as LlmCustomAssertion;
      const itemHeader = `[CHECK ITEM ${checkIndex}]`;
      checklistIndices.push(checkIndex);
      checkIndex++;

      const parts: string[] = [`${itemHeader} CUSTOM SPECIFICATION:`];
      if (customSpec.expectation) {
        parts.push(`  Expectation (Required): "${customSpec.expectation}"`);
      }
      if (customSpec.unexpectation) {
        parts.push(`  Forbidden (Must Avoid): "${customSpec.unexpectation}"`);
      }
      if (customSpec.reference) {
        parts.push(`  Ground Truth Reference: "${customSpec.reference}"`);
      }
      if (customSpec.context && customSpec.context.length > 0) {
        parts.push(`  Context: ${customSpec.context.join("; ")}`);
      }

      parts.push(
        `\n  SCORING RUBRIC (1-5 Likert scale):\n` +
        `  • 5 (Excellent): Fully and accurately satisfies the expectation with zero flaws or fully avoided forbidden behavior.\n` +
        `  • 4 (Good): Meets the core expectation with only minor, harmless omissions.\n` +
        `  • 3 (Acceptable - Pass): Essential requirement satisfied adequately, though minor rough spots exist.\n` +
        `  • 2 (Poor): Notable defects, substantial omissions, or partial failure.\n` +
        `  • 1 (Complete Failure): Wholly fails the requirement, generates contrary statements, or violates forbidden rule.`,
      );

      checklistBlocks.push(parts.join("\n"));
    }
  }

  if (checklistBlocks.length > 0) {
    sections.push(
      "EVALUATION ATOMIC CHECKLIST\n" +
      "Evaluate each check item below independently. For each item, assign an integer score (1-5) and provide a concise reason citing evidence:\n\n" +
      checklistBlocks.join("\n\n---\n\n"),
    );
  }

  // 2. Deterministic check results (for context)
  if (input.checkResults && input.checkResults.length > 0) {
    const checksBlock = formatChecksForPrompt(input.checkResults);
    if (checksBlock.length > 0) {
      sections.push(checksBlock);
    }
  }

  // 3. Conversation transcript
  sections.push(
    "CONVERSATION TO EVALUATE\n" +
    "The following is the complete conversation between the user and " +
    "the target agent. Read it carefully before scoring:\n\n" +
    input.conversationText,
  );

  // 4. Instructions
  sections.push(
    "INSTRUCTIONS\n" +
    "Analyse the conversation above, then call `submit_evaluation_scores` " +
    "EXACTLY ONCE with:\n" +
    `  - item_scores: Array with one entry for each of the ${checklistIndices.length} check items above: ` +
    `[{ index: 0, score: 1-5, reason: "<evidence_and_justification>" }, ...]\n` +
    `    (Use sequential indices 0 to ${checklistIndices.length - 1} matching the check items above)\n` +
    "  - feedback: 2-5 sentence overall summary\n\n" +
    "CRITICAL: You MUST use the `submit_evaluation_scores` tool to return all your scores together. Do not output normal text.",
  );

  return sections.join("\n\n---\n\n");
}
