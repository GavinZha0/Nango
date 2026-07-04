/**
 * Evaluation — single case runner.
 *
 * Executes one eval case end-to-end:
 *   ① Dispatch target agent → capture response + metrics
 *   ② Run deterministic checks (keywords, tools, metrics)
 *   ③ Assemble evaluator prompt
 *   ④ Dispatch evaluator agent → extract structured scores
 *   ⑤ Compute criteria_score_final
 *   ⑥ Write eval_case_result
 *
 * NEVER throws — every error surface is mapped into the result.
 * Called by the suite orchestrator for each case in the serial loop.
 *
 * See docs/evaluation.md.
 */

import "server-only";
import { randomUUID } from "crypto";

import { runner } from "@/lib/runner";
import { readEvents } from "@/lib/runner/event-store";
import { childLogger } from "@/lib/observability/logger";
import type { EntityRunEventEntity } from "@/lib/db/schema";

import type { EvalCriteria, CriteriaCheckResult } from "./types";
import {
  runDeterministicChecks,
  type DeterministicCheckInput,
} from "./deterministic-checks";
import { buildEvaluationBrief } from "./prompt-builder";
import type { SubmitEvaluationScoresSuccess } from "./runtime-tools";
import * as storage from "./storage";

const log = childLogger({ component: "eval-runner" });

// ─── Input / Output ─────────────────────────────────────────────────

export interface RunEvalCaseInput {
  runId: string;
  caseId: number;
  /** Target agent identity. */
  targetAgentId: string;
  targetCredentialId?: string;
  targetEntityKind?: "agent" | "team" | "workflow";
  /** Evaluator agent (builtin only). */
  evaluatorAgentId: string;
  /** Suite-level dimension IDs. */
  dimensionIds: string[];
  /** Case conversation turns (user messages only). */
  turns: Array<{ userMessage: string }>;
  /** Case criteria. */
  criteria: EvalCriteria;
  /** Session user ID — used as ownerId for runner dispatch. */
  ownerId: string;
}

export interface RunEvalCaseResult {
  status: "passed" | "failed" | "errored";
  score: number | null;
  dimensionScores?: Record<string, number>;
  criteriaScore?: number | null;
  criteriaResults?: CriteriaCheckResult[];
  feedback?: string | null;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract unique tool call names from entity_run_event rows. */
function extractToolCallNames(events: EntityRunEventEntity[]): string[] {
  const names = new Set<string>();
  for (const evt of events) {
    if (evt.type !== "tool_call_chunk") continue;
    const payload = evt.payload as { toolName?: string } | null;
    if (payload?.toolName) names.add(payload.toolName);
  }
  return [...names];
}

/** Count output tokens from TEXT_MESSAGE_CHUNK / TEXT_MESSAGE_CONTENT
 *  events. Rough estimate: split by whitespace. A proper token
 *  counter would need the model's tokenizer; this is a reasonable
 *  approximation for scoring purposes. */
function estimateOutputTokens(summary: string): number {
  if (!summary) return 0;
  // Rough heuristic: ~0.75 tokens per whitespace-separated word for English.
  // Good enough for threshold comparison.
  return Math.ceil(summary.split(/\s+/).filter(Boolean).length * 1.3);
}

/** Build conversation text from history for the
 *  evaluator prompt. */
function buildConversationText(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  return history
    .map((msg) => (msg.role === "user" ? `User: ${msg.content}` : `Agent: ${msg.content}`))
    .join("\n\n");
}

/** Parse the evaluator's submit_evaluation_scores tool call from
 *  entity_run_event. Returns null if not found. */
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
      // The tool's execute() returns the result — but for programmatic
      // dispatch we read from the tool_call_chunk args (the LLM's
      // input to the tool), not the tool_call_result (the tool's
      // output). The args ARE the scores.
      if (typeof args.baseline_score !== "number") continue;
      if (typeof args.feedback !== "string") continue;

      const dimensionScores: Record<string, number> = {};
      if (Array.isArray(args.dimension_scores)) {
        for (const d of args.dimension_scores) {
          if (
            typeof d === "object" && d !== null &&
            typeof (d as { id?: unknown }).id === "string" &&
            typeof (d as { score?: unknown }).score === "number"
          ) {
            dimensionScores[(d as { id: string }).id] = (d as { score: number }).score;
          }
        }
      }

      return {
        ok: true,
        baseline_score: args.baseline_score as number,
        dimension_scores: dimensionScores,
        criteria_score: typeof args.criteria_score === "number"
          ? args.criteria_score
          : null,
        feedback: args.feedback as string,
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────

export async function runEvalCase(
  input: RunEvalCaseInput,
): Promise<RunEvalCaseResult> {
  const startMs = Date.now();

  // ── ① Dispatch target agent ───────────────────────────────────

  const currentThreadId = randomUUID();
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let durationMs = 0;
  let outputTokens = 0;
  const actualToolCalls: string[] = [];
  let finalTargetSummary = "";

  for (const turn of input.turns) {
    let targetResult;
    try {
      targetResult = await runner.start({
        entityId: input.targetAgentId,
        credentialId: input.targetCredentialId,
        entityKind: input.targetEntityKind,
        task: turn.userMessage,
        previousMessages: history,
        threadId: currentThreadId,
        mode: "sync",
        initiator: "evaluator",
        ownerId: input.ownerId,
        createdBy: input.ownerId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { event: "target_dispatch_failed", runId: input.runId, caseId: input.caseId, err: message },
        "target agent dispatch failed",
      );
      await writeErrorResult(input, startMs, `Target agent dispatch failed: ${message}`);
      return { status: "errored", score: null, error: message };
    }

    if (targetResult.status === "failed") {
      const message = targetResult.errorMessage ?? "Target agent run failed";
      log.warn(
        { event: "target_run_failed", runId: input.runId, caseId: input.caseId, targetRunId: targetResult.runId },
        message,
      );
      await writeErrorResult(input, startMs, message, targetResult.runId);
      return { status: "errored", score: null, error: message };
    }

    finalTargetSummary = targetResult.summary;

    const targetEvents = await readEvents(targetResult.runId);
    actualToolCalls.push(...extractToolCallNames(targetEvents));
    outputTokens += estimateOutputTokens(targetResult.summary);

    history.push({ role: "user", content: turn.userMessage });
    history.push({ role: "assistant", content: targetResult.summary });
  }

  durationMs = Date.now() - startMs;
  const toolCallCount = actualToolCalls.length;

  // ── ② Deterministic checks ───────────────────────────────────

  const checkInput: DeterministicCheckInput = {
    agentText: finalTargetSummary,
    actualToolCalls,
    metrics: { durationMs, outputTokens, toolCallCount },
  };
  const checks = runDeterministicChecks(
    input.criteria as EvalCriteria,
    checkInput,
  );

  // ── ③ Assemble evaluator prompt ──────────────────────────────

  const conversationText = buildConversationText(history);
  const brief = buildEvaluationBrief({
    dimensionIds: input.dimensionIds,
    criteria: input.criteria as EvalCriteria,
    checkResults: checks.results,
    conversationText,
  });

  // ── ④ Dispatch evaluator agent (with retry) ──────────────────

  let evaluatorResult;
  let scores: SubmitEvaluationScoresSuccess | null = null;
  let retries = 0;
  let lastError = "";

  while (retries < 2) {
    let currentTask = brief;
    if (retries > 0) {
      currentTask += "\n\nSYSTEM WARNING: In your previous attempt, you failed to use the `submit_evaluation_scores` tool. You MUST use the tool to submit your scores. Do NOT output plain text.";
    }

    try {
      evaluatorResult = await runner.start({
        entityId: input.evaluatorAgentId,
        task: currentTask,
        mode: "sync",
        initiator: "evaluator",
        ownerId: input.ownerId,
        createdBy: input.ownerId,
        context: { expectedDimensionIds: input.dimensionIds },
      });

      const evaluatorEvents = await readEvents(evaluatorResult.runId);
      scores = extractEvaluatorScores(evaluatorEvents);

      if (scores) {
        break; // Success!
      } else {
        lastError = "Evaluator did not call submit_evaluation_scores";
        log.warn(
          { event: "evaluator_retry", runId: input.runId, caseId: input.caseId, attempt: retries + 1 },
          lastError,
        );
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error(
        { event: "evaluator_dispatch_failed", runId: input.runId, caseId: input.caseId, err: lastError, attempt: retries + 1 },
        "evaluator agent dispatch failed",
      );
    }
    
    retries++;
  }

  if (!scores || !evaluatorResult) {
    const message = lastError || "Evaluator failed to return scores after retries";
    log.warn(
      { event: "evaluator_failed", runId: input.runId, caseId: input.caseId, evaluatorRunId: evaluatorResult?.runId },
      message,
    );
    await writeErrorResult(input, startMs, message, currentThreadId, evaluatorResult?.runId);
    return { status: "errored", score: null, error: message };
  }

  // ── ⑤ Compute criteria_score_final ───────────────────────────

  const llmCriteriaScore = scores.criteria_score;
  let criteriaScoreFinal: number | null = null;

  if (llmCriteriaScore !== null) {
    criteriaScoreFinal = Math.round(llmCriteriaScore * checks.passRate);
  } else if (checks.totalCount > 0) {
    criteriaScoreFinal = Math.round(100 * checks.passRate);
  }

  // Merge LLM-judged assertion/expectation results back into the
  // checklist. The evaluator's criteria_score covers expectation;
  // individual assertion verdicts are not broken out in V1.
  const mergedResults: CriteriaCheckResult[] = checks.results.map((r) => {
    if (r.kind === "expectation" && llmCriteriaScore !== null) {
      return { ...r, passed: llmCriteriaScore >= 60, score: llmCriteriaScore };
    }
    return r;
  });

  // ── Compute overall case score ───────────────────────────────

  const scoreComponents: number[] = [scores.baseline_score];
  const dimScoreValues = Object.values(scores.dimension_scores);
  if (dimScoreValues.length > 0) scoreComponents.push(...dimScoreValues);
  if (criteriaScoreFinal !== null) scoreComponents.push(criteriaScoreFinal);
  const overallScore = Math.round(
    scoreComponents.reduce((a, b) => a + b, 0) / scoreComponents.length,
  );

  // ── Determine pass/fail ──────────────────────────────────────

  // Import threshold at call time (not module scope) so admin
  // config changes take effect without restart.
  const { EVAL_THRESHOLD_PASS } = await import("./config");
  const passed = overallScore >= EVAL_THRESHOLD_PASS;

  // ── ⑥ Write result ──────────────────────────────────────────

  const finalDimensionScores = {
    ...scores.dimension_scores,
    baseline: scores.baseline_score,
  };

  await storage.writeCaseResult({
    runId: input.runId,
    caseId: input.caseId,
    status: passed ? "passed" : "failed",
    score: overallScore,
    dimensionScores: finalDimensionScores,
    criteriaScore: criteriaScoreFinal,
    criteriaResults: mergedResults,
    feedback: scores.feedback,
    threadId: currentThreadId,
    evaluatorThreadId: evaluatorResult.runId,
    durationMs,
    outputTokens,
    toolCallCount,
  });

  return {
    status: passed ? "passed" : "failed",
    score: overallScore,
    dimensionScores: finalDimensionScores,
    criteriaScore: criteriaScoreFinal,
    criteriaResults: mergedResults,
    feedback: scores.feedback,
    durationMs,
    outputTokens,
  };
}

// ─── Error helper ───────────────────────────────────────────────────

async function writeErrorResult(
  input: RunEvalCaseInput,
  startMs: number,
  errorMessage: string,
  targetRunId?: string,
  evaluatorRunId?: string,
): Promise<void> {
  try {
    await storage.writeCaseResult({
      runId: input.runId,
      caseId: input.caseId,
      status: "errored",
      error: { message: errorMessage },
      threadId: targetRunId ?? null,
      evaluatorThreadId: evaluatorRunId ?? null,
      durationMs: Date.now() - startMs,
    });
  } catch (err) {
    log.error(
      { runId: input.runId, caseId: input.caseId, err: err instanceof Error ? err.message : String(err) },
      "failed to write error case result",
    );
  }
}
