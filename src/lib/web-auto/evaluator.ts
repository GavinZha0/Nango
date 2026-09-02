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
import { type SubmitEvaluationScoresSuccess } from "@/lib/evaluation/runtime-tools";

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
function buildWebAutoEvaluationPrompt(
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
      let block = `${itemHeader} [EXPECTATION]:\n  Target: "${item.expectation}"\n  Rule: PASS (score >= 60) if the UI output affirmatively delivers this requirement; FAIL (score 0-20) if missing, contradicted, or failed.`;
      if (item.referenceImage) {
        block += `\n  Visual reference: [reference screenshot attached: ${item.referenceImage}]`;
      }
      if (item.context && item.context.length > 0) {
        block += `\n  Context notes: ${item.context.join("; ")}`;
      }
      checklistBlocks.push(block);
    } else if (item.unexpectation) {
      let block = `${itemHeader} [UNEXPECTATION / FORBIDDEN]:\n  Target: "${item.unexpectation}"\n  Rule: PASS (score 90-100) if the UI strictly AVOIDED this prohibited content/behavior; FAIL (score 0-15) if it appeared in the output.`;
      if (item.context && item.context.length > 0) {
        block += `\n  Context notes: ${item.context.join("; ")}`;
      }
      checklistBlocks.push(block);
    } else if (item.reference) {
      let block = `${itemHeader} [REFERENCE CONTEXT]:\n  Ground Truth: "${item.reference}"\n  Rule: PASS (score 70-100) if the UI state matches or faithfully aligns with this ground truth; FAIL (score 0-15) if it factually contradicts or replaces it.`;
      if (item.context && item.context.length > 0) {
        block += `\n  Context notes: ${item.context.join("; ")}`;
      }
      checklistBlocks.push(block);
    }
  }

  sections.push(
    "LLM AS JUDGE ATOMIC CHECKLIST\n" +
    "Evaluate each check item below independently against the execution output. For each item, decide whether it passes (score >= 60) or fails (score < 60) and provide a concise reason:\n\n" +
    checklistBlocks.join("\n\n"),
  );

  // 4. Instructions
  sections.push(
    "INSTRUCTIONS\n" +
    "Analyse the execution output above, then call `submit_evaluation_scores` " +
    "EXACTLY ONCE in a single tool call with:\n" +
    "  - baseline_score (always required, 0-100)\n" +
    `  - llm_judge_results (array with one entry for each of the ${expectations.length} check items above, matching index 0 to ${expectations.length - 1}: [{ index: 0, score: 0-100, reason: "..." }, ...])\n` +
    "  - feedback (2-5 sentence overall summary)\n\n" +
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
  for (const evt of events) {
    if (evt.type !== "tool_call_chunk") continue;
    const payload = evt.payload as {
      toolName?: string;
      args?: string;
    } | null;
    if (payload?.toolName !== "submit_evaluation_scores") continue;
    if (!payload.args) continue;

    try {
      const args = JSON.parse(payload.args) as Record<string, unknown>;
      if (typeof args.baseline_score !== "number") continue;
      if (typeof args.feedback !== "string") continue;

      const llmJudgeResults: Array<{ index: number; score: number; reason: string }> = [];
      if (Array.isArray(args.llm_judge_results)) {
        for (const item of args.llm_judge_results) {
          if (
            typeof item === "object" && item !== null &&
            typeof (item as { index?: unknown }).index === "number" &&
            typeof (item as { score?: unknown }).score === "number"
          ) {
            llmJudgeResults.push({
              index: (item as { index: number }).index,
              score: (item as { score: number }).score,
              reason:
                typeof (item as { reason?: unknown }).reason === "string"
                  ? (item as { reason: string }).reason
                  : "",
            });
          }
        }
      }

      return {
        ok: true,
        baseline_score: args.baseline_score as number,
        dimension_scores: {},
        criteria_score:
          typeof args.criteria_score === "number" ? args.criteria_score : null,
        llm_judge_results:
          llmJudgeResults.length > 0 ? llmJudgeResults : undefined,
        feedback: args.feedback as string,
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

  // Extract individual check items with dual-insurance fallback
  const expectationResults: WebAutoExpectationResult[] = [];

  const individualScores: number[] = [];

  for (let i = 0; i < input.expectations.length; i++) {
    const exp = input.expectations[i];
    const itemResult =
      scores.llm_judge_results?.find((r) => r.index === i) ??
      scores.llm_judge_results?.[i];

    const itemScore =
      itemResult?.score ??
      scores.criteria_score ??
      scores.baseline_score ??
      0;
    const itemReason = itemResult?.reason || scores.feedback;

    individualScores.push(itemScore);
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

  // Overall score: average of all atomic LLM checks (or criteria_score)
  const overallScore =
    individualScores.length > 0
      ? Math.round(
          individualScores.reduce((a, b) => a + b, 0) /
            individualScores.length,
        )
      : (scores.criteria_score ?? scores.baseline_score ?? 0);

  const passed = overallScore >= 60; // 60% pass threshold

  return {
    passed,
    score: overallScore,
    feedback: scores.feedback,
    expectationResults,
    durationMs: Date.now() - startMs,
  };
}
