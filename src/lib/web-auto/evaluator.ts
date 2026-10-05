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

import { runner } from "@/lib/runner";
import { readEvents } from "@/lib/runner/event-store";
import { childLogger } from "@/lib/observability/logger";
import type { EntityRunEventEntity } from "@/lib/db/schema";

import type { ErrorEnvelope } from "@/lib/verification/types";
import { submitEvaluationScoresSchema, type SubmitEvaluationScoresSuccess } from "@/lib/evaluation/runtime-tools";

const log = childLogger({ component: "web-auto-evaluator" });

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

/**
 * Extract evaluator scores from entity_run_event.
 */
function extractEvaluatorScores(
  events: EntityRunEventEntity[],
): SubmitEvaluationScoresSuccess | null {
  // Traverse in reverse order to inspect the latest tool call first
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type !== "tool_call_chunk") continue;
    const payload = evt.payload as {
      toolName?: string;
      args?: string;
    } | null;
    if (payload?.toolName !== "submit_evaluation_scores") continue;
    if (!payload.args) continue;

    try {
      const parsedArgs = JSON.parse(payload.args);
      const validation = submitEvaluationScoresSchema.safeParse(parsedArgs);
      if (!validation.success) {
        log.warn(
          { event: "web_auto_evaluator_scores_schema_validation_failed", error: validation.error.format() },
          "web auto evaluator submit_evaluation_scores payload failed schema validation",
        );
        continue;
      }

      return {
        ok: true,
        item_scores: validation.data.item_scores,
        feedback: validation.data.feedback,
      };
    } catch {
      continue;
    }
  }
  return null;
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

  // Dispatch evaluator agent (with retry)
  let targetResult;
  let scores: SubmitEvaluationScoresSuccess | null = null;
  let retries = 0;
  let lastError = "";

  while (retries < 2) {
    let currentTask = evaluationPrompt;
    if (retries > 0) {
      currentTask +=
        "\n\nSYSTEM WARNING: In your previous attempt, you failed to use the `submit_evaluation_scores` tool. You MUST use the tool to submit your scores. Do NOT output plain text.";
    }

    try {
      targetResult = await runner.start({
        entityId: input.evaluatorAgentId,
        task: currentTask,
        mode: "sync",
        initiator: "evaluator",
        ownerId: input.ownerId,
        createdBy: input.ownerId,
        context: { expectedDimensionIds: [] },
      });

      if (targetResult.status === "failed") {
        lastError = targetResult.errorMessage ?? "Evaluator run failed";
        log.warn(
          {
            event: "web_auto_evaluator_run_failed",
            runId: targetResult.runId,
            attempt: retries + 1,
          },
          lastError,
        );
      } else {
        const events = await readEvents(targetResult.runId);
        scores = extractEvaluatorScores(events);
        if (scores) {
          break; // Successfully got scores!
        }
        lastError =
          "Evaluator did not submit scores via submit_evaluation_scores tool";
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error(
        {
          event: "web_auto_evaluator_dispatch_failed",
          err: lastError,
          attempt: retries + 1,
        },
        "evaluator agent dispatch failed",
      );
    }

    retries++;
  }

  if (!scores) {
    return {
      passed: false,
      score: 0,
      expectationResults: input.expectations.map((exp, idx) => ({
        index: idx,
        score: 0,
        reason: lastError || "Evaluator did not submit scores via required tool",
        expectation: exp.expectation,
        unexpectation: exp.unexpectation,
        reference: exp.reference,
      })),
      error: {
        source: "internal",
        message:
          lastError ||
          "Evaluator did not submit scores via submit_evaluation_scores tool",
      },
      durationMs: Date.now() - startMs,
    };
  }

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
    const isScoreValid =
      typeof rawScore === "number" &&
      !Number.isNaN(rawScore) &&
      rawScore >= 1 &&
      rawScore <= 5;

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
