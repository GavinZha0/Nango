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

import type { AssertionSpec, LlmJudgeAssertion } from "@/lib/assertions";
import {
  BUILTIN_DIMENSIONS,
  type CriteriaCheckResult,
} from "./types";
import { formatChecksForPrompt } from "./deterministic-checks";

// ─── Input ──────────────────────────────────────────────────────────

export interface PromptBuilderInput {
  /** Selected suite dimension IDs. */
  dimensionIds: string[];
  /** Unified assertions list (deterministic + llm_judge). */
  assertions: readonly AssertionSpec[];
  /** Deterministic check results from code evaluation. */
  checkResults?: CriteriaCheckResult[];
  /** Full conversation transcript (user + agent turns). */
  conversationText: string;
}

// ─── Builder ────────────────────────────────────────────────────────

/**
 * Assemble the evaluation brief — the user-message prompt sent to
 * the evaluator agent. Builds the per-case evaluation task with
 * baseline dimensions, atomic checklist items, and deterministic results.
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

  // ── 2. LLM Judge Atomic Checklist ───────────────────────────

  const llmAssertions: Array<{ index: number; spec: LlmJudgeAssertion }> = [];
  for (let i = 0; i < (input.assertions ?? []).length; i++) {
    const a = input.assertions[i];
    if (a.type === "llm_judge" || a.type === "expectation" || a.type === "llm_expectation") {
      llmAssertions.push({ index: i, spec: a as LlmJudgeAssertion });
    }
  }

  if (llmAssertions.length > 0) {
    const checklistBlocks: string[] = [];
    for (let i = 0; i < llmAssertions.length; i++) {
      const { index, spec } = llmAssertions[i];
      const itemHeader = `Item #${i + 1} (Index: ${index})`;
      if (spec.expectation) {
        checklistBlocks.push(
          `${itemHeader} [EXPECTATION]:\n` +
          `  Target: "${spec.expectation}"\n` +
          `  Rule: PASS (score >= 60) if the agent output affirmatively delivers this requirement as its core conclusion; FAIL (score 0-20) if missing, contradicted, or merely mentioned while another incompatible option is chosen as primary.`,
        );
      } else if (spec.unexpectation) {
        checklistBlocks.push(
          `${itemHeader} [UNEXPECTATION / FORBIDDEN]:\n` +
          `  Target: "${spec.unexpectation}"\n` +
          `  Rule: PASS (score 90-100) if the agent completely AVOIDED this prohibited content/behavior; FAIL (score 0-15) if it appeared in the output.`,
        );
      } else if (spec.reference) {
        checklistBlocks.push(
          `${itemHeader} [REFERENCE CONTEXT]:\n` +
          `  Ground Truth: "${spec.reference}"\n` +
          `  Rule: PASS (score 70-100) if the agent's output is factually accurate and faithful to this reference without hallucination or contradiction; FAIL (score 0-15) if it factually contradicts, rejects, or replaces this reference (even if mentioned in passing).`,
        );
      }
    }

    if (checklistBlocks.length > 0) {
      sections.push(
        "LLM AS JUDGE ATOMIC CHECKLIST\n" +
        "Evaluate each item below independently. For each item, decide whether it passes (score >= 60) or fails (score < 60) and provide a concise reason:\n\n" +
        checklistBlocks.join("\n\n"),
      );
    }
  }

  // ── 3. Deterministic check results ────────────────────────────

  if (input.checkResults && input.checkResults.length > 0) {
    const checksBlock = formatChecksForPrompt(input.checkResults);
    if (checksBlock.length > 0) {
      sections.push(checksBlock);
    }
  }

  // ── 4. Conversation transcript ────────────────────────────────

  sections.push(
    "CONVERSATION TO EVALUATE\n" +
    "The following is the complete conversation between the user and " +
    "the target agent. Evaluate it against the baseline criteria, " +
    (input.dimensionIds.length > 0 ? "specialized dimensions, " : "") +
    (llmAssertions.length > 0 ? "and atomic checklist above." : "and criteria above.") +
    "\n\n" +
    input.conversationText,
  );

  // ── 5. Scoring instructions ───────────────────────────────────

  const scoreItems = ["baseline_score (always required, 0-100)"];
  if (input.dimensionIds.length > 0) {
    scoreItems.push(
      `dimension_scores (one entry for each: ${input.dimensionIds.join(", ")})`,
    );
  }
  if (llmAssertions.length > 0) {
    scoreItems.push(
      `llm_judge_results (array with one entry for each of the ${llmAssertions.length} check items above, specifying its 'index', 'score' 0-100, and 'reason')`,
    );
  }
  scoreItems.push("feedback (2-5 sentence overall summary)");

  sections.push(
    "INSTRUCTIONS\n" +
    "Analyse the conversation above, then call `submit_evaluation_scores` " +
    "EXACTLY ONCE in a single tool call with:\n" +
    scoreItems.map((s) => `  - ${s}`).join("\n") +
    "\n\nCRITICAL: You MUST use the `submit_evaluation_scores` tool to return all your scores together. Do not output normal text.",
  );

  return sections.join("\n\n---\n\n");
}
