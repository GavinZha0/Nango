/**
 * Unified LLM Judge Runner & Scoring Engine.
 *
 * Provides a consolidated execution lifecycle for LLM evaluator agents across
 * Evaluation and Web Auto subsystems:
 * - Standardized 1-5 Likert scoring scale & validation rules.
 * - Robust invocation with per-turn timeout protection (preventing hangs).
 * - Automatic retry with system warnings when the evaluator fails to call `submit_evaluation_scores`.
 * - Reverse-order event traversal and Zod-schema validation for evaluator results.
 *
 * See docs/evaluation.md and docs/web-auto.md.
 */

import "server-only";

import { runner } from "@/lib/runner";
import { readEvents } from "@/lib/runner/event-store";
import { childLogger } from "@/lib/observability/logger";
import { getConfigNumber } from "@/lib/config";
import type { EntityRunEventEntity } from "@/lib/db/schema";
import {
  submitEvaluationScoresSchema,
  type SubmitEvaluationScoresSuccess,
} from "./runtime-tools";
import { CONFIG_KEY_EVALUATOR_TIMEOUT } from "./config";

const log = childLogger({ component: "judge-runner" });

export const LIKERT_MIN_SCORE = 1;
export const LIKERT_PASS_SCORE = 3;
export const LIKERT_MAX_SCORE = 5;

export const LIKERT_SCORING_RUBRIC =
  `SCORING RUBRIC (1-5 Likert scale):\n` +
  `• 5 (Excellent / Flawless): Fully and accurately satisfies the expectation with zero flaws, or fully avoided forbidden behavior.\n` +
  `• 4 (Good): Meets the core expectation with only minor, harmless omissions.\n` +
  `• 3 (Acceptable - Pass): Essential requirement satisfied adequately, though minor rough spots exist.\n` +
  `• 2 (Poor): Notable defects, substantial omissions, or partial failure.\n` +
  `• 1 (Complete Failure): Wholly fails the requirement, generates contrary statements, or violates forbidden rule.`;

export const EVALUATOR_RETRY_SYSTEM_WARNING =
  "SYSTEM WARNING: In your previous attempt, you failed to use the `submit_evaluation_scores` tool. You MUST use the tool to submit your scores. Do NOT output plain text.";

/**
 * Validates whether a score conforms to the strict 1-5 integer Likert scale.
 */
export function isLikertScoreValid(score: unknown): score is number {
  return (
    typeof score === "number" &&
    !Number.isNaN(score) &&
    Number.isInteger(score) &&
    score >= LIKERT_MIN_SCORE &&
    score <= LIKERT_MAX_SCORE
  );
}

export interface EvaluatorScoreExtractionResult {
  scores: SubmitEvaluationScoresSuccess | null;
  failureReason?: "not_called" | "invalid_json" | "schema_error";
  detail?: string;
}

/**
 * Parse the evaluator's submit_evaluation_scores tool call from entity_run_event.
 * Traversing in reverse order to inspect the latest tool call first, and strictly
 * enforcing Zod schema validation.
 */
export function extractEvaluatorScoresDetailed(
  events: EntityRunEventEntity[],
): EvaluatorScoreExtractionResult {
  let sawToolCall = false;
  let lastFailureReason: "invalid_json" | "schema_error" | undefined;
  let lastDetail: string | undefined;

  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type !== "tool_call_chunk") continue;
    const payload = evt.payload as {
      toolName?: string;
      args?: string;
    } | null;
    if (payload?.toolName !== "submit_evaluation_scores") continue;
    sawToolCall = true;

    if (!payload.args) {
      lastFailureReason = "invalid_json";
      lastDetail = "Missing arguments for submit_evaluation_scores";
      continue;
    }

    try {
      const parsedArgs = JSON.parse(payload.args);
      const validation = submitEvaluationScoresSchema.safeParse(parsedArgs);
      if (!validation.success) {
        lastFailureReason = "schema_error";
        lastDetail = validation.error.issues
          .map((iss) => `${iss.path.join(".") || "root"}: ${iss.message}`)
          .join("; ");
        log.warn(
          {
            event: "evaluator_scores_schema_validation_failed",
            error: validation.error.format(),
          },
          "evaluator submit_evaluation_scores payload failed schema validation",
        );
        continue;
      }

      return {
        scores: {
          ok: true,
          item_scores: validation.data.item_scores,
          feedback: validation.data.feedback,
        },
      };
    } catch (parseErr) {
      lastFailureReason = "invalid_json";
      lastDetail = parseErr instanceof Error ? parseErr.message : String(parseErr);
      continue;
    }
  }

  if (sawToolCall) {
    return {
      scores: null,
      failureReason: lastFailureReason,
      detail: lastDetail,
    };
  }

  return {
    scores: null,
    failureReason: "not_called",
    detail: "Evaluator did not call submit_evaluation_scores",
  };
}

export function extractEvaluatorScores(
  events: EntityRunEventEntity[],
): SubmitEvaluationScoresSuccess | null {
  return extractEvaluatorScoresDetailed(events).scores;
}

/** Timeout wrapper for runner.start dispatches. Shared between judge and eval-runner. */
export async function withStepTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stepName: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${stepName} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ExecuteJudgeInput {
  evaluatorAgentId: string;
  taskPrompt: string;
  ownerId: string;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  context?: Record<string, unknown>;
  logMeta?: Record<string, unknown>;
}

export interface ExecuteJudgeResult {
  success: boolean;
  scores: SubmitEvaluationScoresSuccess | null;
  evaluatorRunId?: string;
  error?: string;
  cancelled?: boolean;
  durationMs: number;
}

/**
 * Dispatches an evaluator agent to judge tasks, with unified timeout protection,
 * automatic retry, and reverse-order tool call extraction.
 */
export async function executeJudge(
  input: ExecuteJudgeInput,
): Promise<ExecuteJudgeResult> {
  const startMs = Date.now();
  const maxRetries = input.maxRetries ?? 2;
  const defaultTimeoutSec = await getConfigNumber(CONFIG_KEY_EVALUATOR_TIMEOUT, 300);
  const timeoutMs = input.timeoutMs ?? defaultTimeoutSec * 1000;

  if (maxRetries <= 0) {
    return {
      success: false,
      scores: null,
      error: "Evaluation skipped: maxRetries set to 0",
      durationMs: Date.now() - startMs,
    };
  }

  let retries = 0;
  let lastError = "";
  let lastEvaluatorRunId: string | undefined;

  while (retries < maxRetries) {
    if (input.signal?.aborted) {
      return {
        success: false,
        scores: null,
        cancelled: true,
        evaluatorRunId: lastEvaluatorRunId,
        error: "Cancelled: client disconnected before evaluation finished",
        durationMs: Date.now() - startMs,
      };
    }

    let currentTask = input.taskPrompt;
    if (retries > 0) {
      currentTask += `\n\n${EVALUATOR_RETRY_SYSTEM_WARNING}`;
    }

    try {
      const targetResult = await withStepTimeout(
        runner.start({
          entityId: input.evaluatorAgentId,
          task: currentTask,
          mode: "sync",
          initiator: "evaluator",
          ownerId: input.ownerId,
          createdBy: input.ownerId,
          context: input.context,
        }),
        timeoutMs,
        "Evaluator agent",
      );

      lastEvaluatorRunId = targetResult.runId;

      if (targetResult.status === "failed") {
        lastError = `Evaluator agent run failed: ${targetResult.errorMessage ?? "unknown error"}`;
        log.warn(
          {
            event: "judge_evaluator_run_failed",
            runId: targetResult.runId,
            attempt: retries + 1,
            ...input.logMeta,
          },
          lastError,
        );
      } else {
        const events = await readEvents(targetResult.runId);
        const extraction = extractEvaluatorScoresDetailed(events);
        if (extraction.scores) {
          return {
            success: true,
            scores: extraction.scores,
            evaluatorRunId: targetResult.runId,
            durationMs: Date.now() - startMs,
          };
        }

        if (extraction.failureReason === "schema_error") {
          lastError = `Evaluator called submit_evaluation_scores but arguments failed schema validation: ${extraction.detail}`;
        } else if (extraction.failureReason === "invalid_json") {
          lastError = `Evaluator called submit_evaluation_scores but arguments were not valid JSON: ${extraction.detail}`;
        } else {
          lastError = "Evaluator did not call submit_evaluation_scores";
        }

        log.warn(
          {
            event: "judge_evaluator_retry",
            runId: targetResult.runId,
            attempt: retries + 1,
            failureReason: extraction.failureReason,
            ...input.logMeta,
          },
          lastError,
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("timed out")) {
        lastError = errMsg;
      } else {
        lastError = `Evaluator agent dispatch failed: ${errMsg}`;
      }
      log.error(
        {
          event: "judge_evaluator_dispatch_failed",
          err: lastError,
          attempt: retries + 1,
          ...input.logMeta,
        },
        "judge evaluator agent dispatch failed",
      );
    }

    retries++;
  }

  return {
    success: false,
    scores: null,
    evaluatorRunId: lastEvaluatorRunId,
    error: lastError || "Evaluator did not call submit_evaluation_scores",
    durationMs: Date.now() - startMs,
  };
}
