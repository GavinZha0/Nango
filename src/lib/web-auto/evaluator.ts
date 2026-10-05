/**
 * Web Auto — LLM evaluation layer for expectation assertions.
 *
 * Simplified evaluator that dispatches the suite's evaluator agent
 * to assess natural language expectations against Playwright execution output.
 * Reuses evaluation's tool pattern but with a focused scope (expectation evaluation only).
 *
 * See docs/web-auto.md.
 */

import "server-only";

import type { ErrorEnvelope } from "@/lib/verification/types";
import { executeJudge, isLikertScoreValid } from "@/lib/evaluation/judge.server";

// ─── Input / Output ─────────────────────────────────────────────────

export interface WebAutoExpectationItem {
  expectation?: string;
  unexpectation?: string;
  reference?: string;
  referenceImage?: string;
  context?: string[];
}

export interface RunWebAutoEvaluationInput {
  /** Evaluator agent ID (from suite.evaluatorAgentId) */
  evaluatorAgentId: string;
  /** Playwright execution output (screenshots, DOM, structured results) */
  executionOutput: unknown;
  /** Expectation assertions to evaluate */
  expectations: WebAutoExpectationItem[];
  /** Session user ID for runner dispatch */
  ownerId: string;
  /** Optional cancellation signal */
  signal?: AbortSignal;
  /** Optional evaluator turn timeout in milliseconds */
  timeoutMs?: number;
}

export interface WebAutoExpectationResult {
  index: number;
  score: number;
  reason: string;
  feedback?: string;
  expectation?: string;
  unexpectation?: string;
  reference?: string;
}

export interface WebAutoEvaluationResult {
  passed: boolean;
  score?: number;
  feedback?: string;
  expectationResults: WebAutoExpectationResult[];
  error?: ErrorEnvelope;
  durationMs?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Build evaluation prompt for Web Auto expectation assessment.
 * Aligned with Evaluation module's atomic checklist structure.
 */
export function buildWebAutoEvaluationPrompt(
  executionOutput: unknown,
  expectations: WebAutoExpectationItem[],
): string {
  const sections: string[] = [];

  // 1. Role and brief header
  sections.push(
    "You are an expert web UI automation evaluator. Your task is to assess whether " +
    "the Playwright execution output satisfies the checklist of UI assertions below.",
  );

  // 2. Execution output
  const outputText =
    typeof executionOutput === "string"
      ? executionOutput
      : JSON.stringify(executionOutput, null, 2);

  sections.push(`EXECUTION OUTPUT\n${outputText}`);

  // 3. Atomic checklist items
  const checklistBlocks: string[] = [];
  for (let i = 0; i < expectations.length; i++) {
    const item = expectations[i];
    const itemHeader = `[CHECK ITEM ${i}]`;

    if (item.expectation) {
      let block = `${itemHeader} [EXPECTATION]:\n  Target: "${item.expectation}"\n  Rule: PASS (score 3-5) if the UI output affirmatively delivers this requirement; FAIL (score 1-2) if missing, contradicted, or failed.`;
      if (item.referenceImage) {
        block += `\n  Visual reference: [reference screenshot attached: ${item.referenceImage}]`;
      }
      if (item.context && item.context.length > 0) {
        block += `\n  Context notes: ${item.context.join("; ")}`;
      }
      checklistBlocks.push(block);
    } else if (item.unexpectation) {
      let block = `${itemHeader} [UNEXPECTATION / FORBIDDEN]:\n  Target: "${item.unexpectation}"\n  Rule: PASS (score 4-5) if the UI strictly AVOIDED this prohibited content/behavior; FAIL (score 1-2) if it appeared in the output.`;
      if (item.context && item.context.length > 0) {
        block += `\n  Context notes: ${item.context.join("; ")}`;
      }
      checklistBlocks.push(block);
    } else if (item.reference) {
      let block = `${itemHeader} [REFERENCE CONTEXT]:\n  Ground Truth: "${item.reference}"\n  Rule: PASS (score 3-5) if the UI state matches or faithfully aligns with this ground truth; FAIL (score 1-2) if it factually contradicts or replaces it.`;
      if (item.context && item.context.length > 0) {
        block += `\n  Context notes: ${item.context.join("; ")}`;
      }
      checklistBlocks.push(block);
    }
  }

  sections.push(
    "LLM AS JUDGE ATOMIC CHECKLIST\n" +
    "Evaluate each check item below independently against the execution output. For each item, decide whether it passes (score >= 3) or fails (score < 3) on a 1-5 Likert scale and provide a concise reason:\n\n" +
    checklistBlocks.join("\n\n"),
  );

  // 4. Instructions
  sections.push(
    "INSTRUCTIONS\n" +
    "Analyse the execution output above, then call `submit_evaluation_scores` " +
    "EXACTLY ONCE in a single tool call with:\n" +
    `  - item_scores: Array with one entry for each of the ${expectations.length} check items above: ` +
    `[{ index: 0, score: 1-5, reason: "..." }, ...]\n` +
    "    Scores MUST be integers between 1 and 5 (1 = Complete Failure / Prohibited behavior occurred, 2 = Poor / Partial, 3 = Acceptable, 4 = Good, 5 = Flawless). Scores outside 1-5 are strictly invalid.\n" +
    "  - feedback: 2-5 sentence overall summary\n\n" +
    "CRITICAL: You MUST use the `submit_evaluation_scores` tool to return all your scores together. Do not output normal text.",
  );

  return sections.join("\n\n---\n\n");
}

// ─── Main ───────────────────────────────────────────────────────────

/**
 * Run LLM evaluation for Web Auto expectations.
 */
export async function runWebAutoEvaluation(
  input: RunWebAutoEvaluationInput,
): Promise<WebAutoEvaluationResult> {
  const startMs = Date.now();

  if (input.expectations.length === 0) {
    // No expectations to evaluate - auto-pass
    return {
      passed: true,
      expectationResults: [],
      durationMs: Date.now() - startMs,
    };
  }

  // Build evaluation prompt
  const evaluationPrompt = buildWebAutoEvaluationPrompt(
    input.executionOutput,
    input.expectations,
  );

  // Dispatch evaluator agent via unified judge runner
  const judgeResult = await executeJudge({
    evaluatorAgentId: input.evaluatorAgentId,
    taskPrompt: evaluationPrompt,
    ownerId: input.ownerId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    context: { expectedDimensionIds: [] },
    logMeta: { expectationsCount: input.expectations.length },
  });

  if (!judgeResult.success || !judgeResult.scores) {
    const errorMsg =
      judgeResult.error ||
      "Evaluator did not submit scores via submit_evaluation_scores tool";
    return {
      passed: false,
      score: 0,
      expectationResults: input.expectations.map((exp, idx) => ({
        index: idx,
        score: 0,
        reason: errorMsg,
        expectation: exp.expectation,
        unexpectation: exp.unexpectation,
        reference: exp.reference,
      })),
      error: {
        source: "internal",
        message: errorMsg,
      },
      durationMs: Date.now() - startMs,
    };
  }

  const scores = judgeResult.scores;

  // Extract individual check items
  const expectationResults: WebAutoExpectationResult[] = [];
  const individualScores: number[] = [];
  let evaluatorError: string | null = null;

  for (let i = 0; i < input.expectations.length; i++) {
    const exp = input.expectations[i];
    const itemResult = scores.item_scores?.find((r) => r.index === i);

    if (!itemResult) {
      if (!evaluatorError) {
        evaluatorError = `Evaluator omitted score for check item ${i}`;
      }
      expectationResults.push({
        index: i,
        score: 0,
        reason: "Evaluator failed to submit score for this item",
        feedback: "Evaluator failed to submit score for this item",
        expectation: exp.expectation,
        unexpectation: exp.unexpectation,
        reference: exp.reference,
      });
      continue;
    }

    const rawScore = itemResult.score;
    const isScoreValid = isLikertScoreValid(rawScore);

    if (!isScoreValid && !evaluatorError) {
      evaluatorError = `Evaluator score ${rawScore} is invalid (expected integer between 1 and 5)`;
    }

    const itemScore = isScoreValid ? Math.round(rawScore) : 0;
    const itemReason = itemResult.reason || scores.feedback;

    if (itemScore >= 1) {
      individualScores.push(itemScore);
    }
    expectationResults.push({
      index: i,
      score: itemScore,
      reason: itemReason,
      feedback: itemReason,
      expectation: exp.expectation,
      unexpectation: exp.unexpectation,
      reference: exp.reference,
    });
  }

  const allItemsScored =
    expectationResults.length === input.expectations.length &&
    expectationResults.every((r) => r.score >= 1);
  const minScore = individualScores.length > 0 ? Math.min(...individualScores) : 0;
  const passed = !evaluatorError && allItemsScored && minScore >= 3; // 3 on 1-5 scale

  return {
    passed,
    score: allItemsScored ? minScore : undefined,
    feedback: scores.feedback,
    expectationResults,
    error: evaluatorError
      ? {
          source: "internal",
          message: evaluatorError,
        }
      : undefined,
    durationMs: Date.now() - startMs,
  };
}
