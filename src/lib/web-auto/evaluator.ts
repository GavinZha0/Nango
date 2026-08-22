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

export interface RunWebAutoEvaluationInput {
  /** Evaluator agent ID (from suite.evaluatorAgentId) */
  evaluatorAgentId: string;
  /** Playwright execution output (screenshots, DOM, structured results) */
  executionOutput: unknown;
  /** Expectation assertions to evaluate */
  expectations: Array<{
    expectation: string;
    referenceImage?: string;
    context?: string[];
  }>;
  /** Session user ID for runner dispatch */
  ownerId: string;
}

export interface WebAutoEvaluationResult {
  passed: boolean;
  score?: number;
  feedback?: string;
  expectationResults: Array<{
    expectation: string;
    score: number;
    feedback: string;
  }>;
  error?: ErrorEnvelope;
  durationMs: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Build evaluation prompt for Web Auto expectation assessment.
 */
function buildWebAutoEvaluationPrompt(
  executionOutput: unknown,
  expectations: Array<{ expectation: string; referenceImage?: string; context?: string[] }>,
): string {
  const outputText = typeof executionOutput === "string" 
    ? executionOutput 
    : JSON.stringify(executionOutput, null, 2);

  const expectationsText = expectations
    .map((exp, idx) => {
      let text = `${idx + 1}. ${exp.expectation}`;
      if (exp.referenceImage) {
        text += `\n   Reference image: [base64 image data available]`;
      }
      if (exp.context && exp.context.length > 0) {
        text += `\n   Context: ${exp.context.join("; ")}`;
      }
      return text;
    })
    .join("\n");

  return `You are an expert web UI evaluator. Your task is to assess whether the Playwright execution output meets the natural language expectations.

EXECUTION OUTPUT
${outputText}

EXPECTATIONS TO EVALUATE
${expectationsText}

EVALUATION METHOD
1. For each expectation, carefully examine the execution output (screenshots, DOM state, structured results).
2. Determine if the expectation is satisfied (e.g., "success toast visible" → check for toast element in DOM or screenshot).
3. Assign a score (0-100) for each expectation based on how well it is met.
4. Provide brief feedback for each expectation explaining the score.

SCORING RUBRIC
90-100: Expectation fully satisfied with clear evidence.
70-89: Expectation mostly satisfied with minor issues.
40-69: Expectation partially satisfied with notable gaps.
1-39: Expectation largely not satisfied.
0: Expectation completely failed or no evidence.

CRITICAL INSTRUCTION: You MUST use the \`submit_evaluation_scores\` tool to return your scores. Use the \`criteria_score\` field for the overall expectation score (average of all individual expectations). DO NOT output your scores as plain text or Markdown.`;
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
      if (typeof args.criteria_score !== "number") continue;

      return {
        ok: true,
        baseline_score: args.baseline_score as number,
        dimension_scores: {},
        criteria_score: args.criteria_score as number,
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
      currentTask += "\n\nSYSTEM WARNING: In your previous attempt, you failed to use the `submit_evaluation_scores` tool. You MUST use the tool to submit your scores. Do NOT output plain text.";
    }

    try {
      targetResult = await runner.start({
        entityId: input.evaluatorAgentId,
        task: currentTask,
        mode: "sync",
        initiator: "evaluator",
        ownerId: input.ownerId,
        createdBy: input.ownerId,
      });

      if (targetResult.status === "failed") {
        lastError = targetResult.errorMessage ?? "Evaluator run failed";
        log.warn(
          { event: "web_auto_evaluator_run_failed", runId: targetResult.runId, attempt: retries + 1 },
          lastError,
        );
      } else {
        const events = await readEvents(targetResult.runId);
        scores = extractEvaluatorScores(events);
        if (scores) {
          break; // Successfully got scores!
        }
        lastError = "Evaluator did not submit scores via submit_evaluation_scores tool";
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error(
        { event: "web_auto_evaluator_dispatch_failed", err: lastError, attempt: retries + 1 },
        "evaluator agent dispatch failed",
      );
    }

    retries++;
  }

  if (!scores) {
    return {
      passed: false,
      expectationResults: input.expectations.map((exp) => ({
        expectation: exp.expectation,
        score: 0,
        feedback: lastError || "Evaluator did not submit scores via required tool",
      })),
      error: {
        source: "internal",
        message: lastError || "Evaluator did not submit scores via submit_evaluation_scores tool",
      },
      durationMs: Date.now() - startMs,
    };
  }

  // Determine pass/fail based on criteria_score (expectation score)
  const passed = (scores.criteria_score ?? 0) >= 60; // 60% threshold for passing

  // Build individual expectation results
  const expectationResults = input.expectations.map((exp) => ({
    expectation: exp.expectation,
    score: scores.criteria_score ?? 0,
    feedback: scores.feedback,
  }));

  return {
    passed,
    score: scores.criteria_score ?? undefined,
    feedback: scores.feedback,
    expectationResults,
    durationMs: Date.now() - startMs,
  };
}
