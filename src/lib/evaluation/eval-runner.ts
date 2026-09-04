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

import type { AssertionSpec } from "@/lib/assertions";
import {
  isJudgeDependentType,
  REASON_DIMENSIONS_REQUIRE_EVALUATOR,
  REASON_EVALUATOR_NOT_CONFIGURED,
  REASON_SKIPPED_DETERMINISTIC_GATE,
  type AssertionResult,
  type LlmJudgeAssertion,
} from "@/lib/assertions";
import {
  runDeterministicChecks,
  type DeterministicCheckInput,
} from "./deterministic-checks";
import { buildEvaluationBrief } from "./prompt-builder";
import type { SubmitEvaluationScoresSuccess } from "./runtime-tools";
import * as storage from "./storage";
import { getConfigNumber } from "@/lib/config";
import {
  DEFAULT_EVAL_TARGET_TIMEOUT_S,
  DEFAULT_EVAL_EVALUATOR_TIMEOUT_S,
  CONFIG_KEY_TARGET_TIMEOUT,
  CONFIG_KEY_EVALUATOR_TIMEOUT,
} from "./config";

const log = childLogger({ component: "eval-runner" });

// ─── Input / Output ─────────────────────────────────────────────────

export interface RunEvalCaseInput {
  runId?: string;
  caseId: number;
  /** Target agent identity. */
  targetAgentId: string;
  targetCredentialId?: string;
  /** "builtin" = built-in agent; "backend" = backend platform agent (e.g. Agno). */
  agentSource: "builtin" | "backend";
  /** Backend entity interface kind (agent | team | workflow). Only used for
   *  backend targets; defaults to "agent". */
  targetEntityKind?: "agent" | "team" | "workflow";
  /** Evaluator agent (builtin only, optional for deterministic-only suites). */
  evaluatorAgentId?: string | null;
  /** Suite-level dimension IDs. */
  dimensionIds: string[];
  /** Case conversation turns (user messages only). */
  turns: Array<{ userMessage: string }>;
  /** Case assertions (deterministic + LLM judge). */
  assertions: readonly AssertionSpec[];
  /** Session user ID — used as ownerId for runner dispatch. */
  ownerId: string;
}

export interface RunEvalCaseResult {
  status: "passed" | "failed" | "errored";
  score: number | null;
  dimensionScores?: Record<string, number>;
  assertionScore?: number | null;
  assertionResults?: import("@/lib/assertions").AssertionResult[];
  feedback?: string | null;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
  threadId?: string;
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
              reason: typeof (item as { reason?: unknown }).reason === "string" ? (item as { reason: string }).reason : "",
            });
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
        llm_judge_results: llmJudgeResults.length > 0 ? llmJudgeResults : undefined,
        feedback: args.feedback as string,
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function withStepTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stepName: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${stepName} timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REASON_EVALUATOR_FAILED =
  "Evaluator failed to return scores after retries; LLM judge assertions were not evaluated.";

/**
 * Append `skipped` placeholder rows for LLM judge assertions that could not be
 * evaluated, preserving absolute indices so stored `assertionResults` always
 * stays aligned 1:1 with the case's `assertions` array. Skipped rows carry no
 * score — they mean "not evaluated", never "judged as 0".
 */
function withSkippedJudgeRows(
  evaluatedRows: readonly AssertionResult[],
  llmAssertions: ReadonlyArray<{ index: number; spec: LlmJudgeAssertion }>,
  reason: string,
): AssertionResult[] {
  const rows: AssertionResult[] = [...evaluatedRows];
  for (const { index, spec } of llmAssertions) {
    rows.push({
      index,
      type: "llm_judge",
      ok: false,
      skipped: true,
      reason,
      expectation: spec.expectation,
      unexpectation: spec.unexpectation,
      reference: spec.reference,
      dimensionId: spec.dimensionId,
    });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows;
}

/** Scan raw specs (before the engine ran) for judge-dependent items — used to
 *  short-circuit cases that have nothing executable without an evaluator. */
function judgeAssertionsFromSpecs(
  assertions: readonly AssertionSpec[],
): Array<{ index: number; spec: LlmJudgeAssertion }> {
  const out: Array<{ index: number; spec: LlmJudgeAssertion }> = [];
  for (let i = 0; i < assertions.length; i += 1) {
    const a = assertions[i];
    if (isJudgeDependentType(a.type)) {
      out.push({ index: i, spec: a as LlmJudgeAssertion });
    }
  }
  return out;
}

/**
 * Terminal `errored` outcome for a configuration problem (missing evaluator).
 * Score stays null — a missing judge is not a graded 0. Persists when part of
 * a suite run. `extraRows` are already-evaluated deterministic results (kept
 * for diagnostics); judge rows are appended as `skipped` so stored rows stay
 * aligned 1:1 with the assertions array.
 */
async function configErrorOutcome(
  input: RunEvalCaseInput,
  startMs: number,
  message: string,
  extraRows: readonly AssertionResult[] = [],
  skippedJudgeRows?: Array<{ index: number; spec: LlmJudgeAssertion }>,
): Promise<RunEvalCaseResult> {
  const assertionResults = withSkippedJudgeRows(
    extraRows,
    skippedJudgeRows ?? [],
    message,
  );
  const error = {
    source: "config",
    message,
    details: { missing: "evaluatorAgentId", caseId: input.caseId },
  };

  if (input.runId) {
    await storage.writeCaseResult({
      runId: input.runId,
      caseId: input.caseId,
      status: "errored",
      score: null,
      dimensionScores: {},
      assertionScore: null,
      assertionResults,
      feedback: message,
      threadId: null,
      evaluatorThreadId: null,
      durationMs: Date.now() - startMs,
      outputTokens: null,
      toolCallCount: null,
      error,
    });
  }

  return {
    status: "errored",
    score: null,
    dimensionScores: {},
    assertionResults,
    feedback: message,
    error: message,
    durationMs: Date.now() - startMs,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

export async function runEvalCase(
  input: RunEvalCaseInput,
): Promise<RunEvalCaseResult> {
  const startMs = Date.now();

  // Read configurable turn timeouts (default: 180s = 3m)
  const targetTimeoutSec = await getConfigNumber(CONFIG_KEY_TARGET_TIMEOUT, DEFAULT_EVAL_TARGET_TIMEOUT_S);
  const targetTimeoutMs = (targetTimeoutSec > 0 ? targetTimeoutSec : DEFAULT_EVAL_TARGET_TIMEOUT_S) * 1000;

  const evaluatorTimeoutSec = await getConfigNumber(CONFIG_KEY_EVALUATOR_TIMEOUT, DEFAULT_EVAL_EVALUATOR_TIMEOUT_S);
  const evaluatorTimeoutMs = (evaluatorTimeoutSec > 0 ? evaluatorTimeoutSec : DEFAULT_EVAL_EVALUATOR_TIMEOUT_S) * 1000;

  // Backend platform agents (e.g. Agno) expose distinct entity interfaces
  // (agent | team | workflow); built-in targets are always dispatched as a
  // plain agent. Only "agent" is exercised today, so backend targets default
  // to "agent" while keeping the escape hatch for future entity kinds.
  const targetEntityKind: "agent" | "team" | "workflow" | undefined =
    input.agentSource === "builtin" ? undefined : (input.targetEntityKind ?? "agent");

  // ── Pre-flight: evaluator-dependent work without an evaluator ─────────
  // A dimension-bearing suite, or a case whose assertions are ALL judge
  // dependent, cannot produce any verdict without an evaluator agent. Error out
  // before dispatching the target (which would only burn model calls). Mixed
  // cases DO run — deterministic assertions can still expose real defects — and
  // are resolved after the deterministic checks below.
  if (!input.evaluatorAgentId) {
    if ((input.dimensionIds ?? []).length > 0) {
      return configErrorOutcome(input, startMs, REASON_DIMENSIONS_REQUIRE_EVALUATOR);
    }
    const specs = input.assertions ?? [];
    const judgeSpecs = judgeAssertionsFromSpecs(specs);
    if (judgeSpecs.length > 0 && judgeSpecs.length === specs.length) {
      return configErrorOutcome(input, startMs, REASON_EVALUATOR_NOT_CONFIGURED, [], judgeSpecs);
    }
  }

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
      targetResult = await withStepTimeout(
        runner.start({
          entityId: input.targetAgentId,
          credentialId: input.targetCredentialId,
          entityKind: targetEntityKind,
          task: turn.userMessage,
          previousMessages: history,
          threadId: currentThreadId,
          mode: "sync",
          initiator: "evaluator",
          ownerId: input.ownerId,
          createdBy: input.ownerId,
        }),
        targetTimeoutMs,
        "Target agent turn",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { event: "target_dispatch_failed", runId: input.runId, caseId: input.caseId, err: message },
        "target agent dispatch failed",
      );
      await writeErrorResult(input, startMs, `Target agent dispatch failed: ${message}`, currentThreadId);
      return { status: "errored", score: null, error: message, threadId: currentThreadId };
    }

    if (targetResult.status === "failed") {
      const message = targetResult.errorMessage ?? "Target agent run failed";
      log.warn(
        { event: "target_run_failed", runId: input.runId, caseId: input.caseId, targetRunId: targetResult.runId },
        message,
      );
      await writeErrorResult(input, startMs, message, currentThreadId);
      return { status: "errored", score: null, error: message, threadId: currentThreadId };
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

  const assertions = input.assertions ?? [];
  const checkInput: DeterministicCheckInput = {
    agentText: finalTargetSummary,
    actualToolCalls,
    metrics: { durationMs, outputTokens, toolCallCount },
  };
  const checks = runDeterministicChecks(
    assertions,
    checkInput,
  );

  // ── Fail-Fast: if deterministic assertions failed, stop immediately with score 0 ──
  const hasDeterministicFailure =
    checks.totalCount > 0 && checks.passedCount < checks.totalCount;

  if (hasDeterministicFailure) {
    const overallScore = 0;
    const assertionScoreFinal = 0;
    const feedback = "Deterministic assertions failed. Evaluator was skipped.";
    // LLM judge assertions were not evaluated — keep them as `skipped` rows so
    // the stored assertionResults stays 1:1 with the assertions array instead
    // of silently dropping the judge half (index holes).
    const finalAssertionResults = withSkippedJudgeRows(
      checks.assertionResults,
      checks.llmAssertions,
      REASON_SKIPPED_DETERMINISTIC_GATE,
    );

    if (input.runId) {
      await storage.writeCaseResult({
        runId: input.runId,
        caseId: input.caseId,
        status: "failed",
        score: overallScore,
        dimensionScores: {},
        assertionScore: assertionScoreFinal,
        assertionResults: finalAssertionResults,
        feedback,
        threadId: currentThreadId,
        evaluatorThreadId: null,
        durationMs,
        outputTokens,
        toolCallCount,
      });
    }

    return {
      status: "failed",
      score: overallScore,
      dimensionScores: {},
      assertionScore: assertionScoreFinal,
      assertionResults: finalAssertionResults,
      feedback,
      durationMs,
      outputTokens,
      threadId: currentThreadId,
    };
  }

  // ── No evaluator agent configured ──────────────────────────────
  if (!input.evaluatorAgentId) {
    // Mixed case: the deterministic portion passed (a deterministic failure
    // would have returned in the fail-fast branch above), but the LLM judge
    // half cannot run — the verdict is incomplete, never a pass.
    if (checks.llmAssertions.length > 0) {
      return configErrorOutcome(
        input,
        startMs,
        REASON_EVALUATOR_NOT_CONFIGURED,
        checks.assertionResults,
        checks.llmAssertions,
      );
    }

    // Purely deterministic evaluation (no judge-dependent assertions and no
    // suite dimensions — pre-flight rejected those combinations above).
    const assertionScoreFinal = 100;
    const overallScore = 100;
    const feedback =
      checks.totalCount > 0
        ? "All deterministic assertions passed."
        : "Target execution completed without errors (smoke test).";

    if (input.runId) {
      await storage.writeCaseResult({
        runId: input.runId,
        caseId: input.caseId,
        status: "passed",
        score: overallScore,
        dimensionScores: {},
        assertionScore: assertionScoreFinal,
        assertionResults: checks.assertionResults,
        feedback,
        threadId: currentThreadId,
        evaluatorThreadId: null,
        durationMs,
        outputTokens,
        toolCallCount,
      });
    }

    return {
      status: "passed",
      score: overallScore,
      dimensionScores: {},
      assertionScore: assertionScoreFinal,
      assertionResults: checks.assertionResults,
      feedback,
      durationMs,
      outputTokens,
      threadId: currentThreadId,
    };
  }

  // ── ③ Assemble evaluator prompt ──────────────────────────────

  const conversationText = buildConversationText(history);
  const brief = buildEvaluationBrief({
    dimensionIds: input.dimensionIds,
    assertions,
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
      evaluatorResult = await withStepTimeout(
        runner.start({
          entityId: input.evaluatorAgentId,
          task: currentTask,
          mode: "sync",
          initiator: "evaluator",
          ownerId: input.ownerId,
          createdBy: input.ownerId,
          context: { expectedDimensionIds: input.dimensionIds },
        }),
        evaluatorTimeoutMs,
        "Evaluator agent",
      );

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
    const assertionScoreFinal = checks.totalCount > 0 ? 100 : null;
    // Keep deterministic results and mark the judge half as not evaluated so
    // stored rows stay aligned 1:1 with the assertions array (no index holes).
    const finalAssertionResults = withSkippedJudgeRows(
      checks.assertionResults,
      checks.llmAssertions,
      REASON_EVALUATOR_FAILED,
    );
    await writeErrorResult(input, startMs, message, currentThreadId, evaluatorResult?.runId, {
      assertionScore: assertionScoreFinal,
      assertionResults: finalAssertionResults,
      durationMs,
      outputTokens,
      toolCallCount,
    });
    return {
      status: "errored",
      score: null,
      assertionScore: assertionScoreFinal,
      assertionResults: finalAssertionResults,
      error: message,
      threadId: currentThreadId,
      durationMs,
      outputTokens,
    };
  }

  // ── ⑤ Process LLM Judge check results & compute assertionScoreFinal ──

  const { EVAL_THRESHOLD_PASS } = await import("./config");

  const unifiedAssertionResults: import("@/lib/assertions").AssertionResult[] = [
    ...(checks.assertionResults ?? []),
  ];

  const llmJudgeScoresList: number[] = [];

  if (checks.llmAssertions && checks.llmAssertions.length > 0) {
    for (let i = 0; i < checks.llmAssertions.length; i++) {
      const item = checks.llmAssertions[i];
      const originalIndex = item.index;
      const spec = item.spec;

      // Dual-insurance matching: match by relative index i, array position, or originalIndex fallback
      const itemResult =
        scores.llm_judge_results?.find((r) => r.index === i) ??
        scores.llm_judge_results?.[i] ??
        scores.llm_judge_results?.find((r) => r.index === originalIndex);

      const itemScore =
        itemResult?.score ?? scores.criteria_score ?? scores.baseline_score;
      const itemOk = itemScore >= EVAL_THRESHOLD_PASS;
      const itemReason = itemResult?.reason || scores.feedback;

      llmJudgeScoresList.push(itemScore);

      unifiedAssertionResults.push({
        index: originalIndex,
        type: "llm_judge",
        ok: itemOk,
        score: itemScore,
        reason: itemReason,
        feedback: itemReason,
        expectation: spec.expectation,
        unexpectation: spec.unexpectation,
        reference: spec.reference,
        dimensionId: spec.dimensionId,
      });
    }
    unifiedAssertionResults.sort((a, b) => a.index - b.index);
  }

  // ── Compute overall case score with 2/3 Case Judge + 1/3 General Dimensions ──
  const generalDimScores: number[] = [scores.baseline_score];
  const customDimScores = Object.values(scores.dimension_scores);
  if (customDimScores.length > 0) {
    generalDimScores.push(...customDimScores);
  }
  const avgGeneralDimScore =
    generalDimScores.reduce((a, b) => a + b, 0) / generalDimScores.length;

  let semanticScore: number;
  let assertionScoreFinal: number | null = null;

  if (llmJudgeScoresList.length > 0) {
    const avgCaseJudgeScore =
      llmJudgeScoresList.reduce((a, b) => a + b, 0) / llmJudgeScoresList.length;
    // 2/3 Case-specific LLM Judge + 1/3 General Quality Dimensions
    semanticScore = (2 / 3) * avgCaseJudgeScore + (1 / 3) * avgGeneralDimScore;
    assertionScoreFinal = Math.round(avgCaseJudgeScore * checks.passRate);
  } else if (scores.criteria_score !== null) {
    semanticScore = (2 / 3) * scores.criteria_score + (1 / 3) * avgGeneralDimScore;
    assertionScoreFinal = Math.round(scores.criteria_score * checks.passRate);
  } else {
    // No case-specific LLM Judge: 100% General Quality Dimensions
    semanticScore = avgGeneralDimScore;
    if (checks.totalCount > 0) {
      assertionScoreFinal = Math.round(100 * checks.passRate);
    }
  }

  // Gated by deterministic checks pass rate (e.g. 0 on deterministic failure)
  const overallScore = Math.round(semanticScore * checks.passRate);

  // ── Determine pass/fail ──────────────────────────────────────
  const passed = overallScore >= EVAL_THRESHOLD_PASS && checks.passRate === 1.0;

  // ── ⑥ Write result ──────────────────────────────────────────

  const finalDimensionScores = {
    ...scores.dimension_scores,
    baseline: scores.baseline_score,
  };

  if (input.runId) {
    await storage.writeCaseResult({
      runId: input.runId,
      caseId: input.caseId,
      status: passed ? "passed" : "failed",
      score: overallScore,
      dimensionScores: finalDimensionScores,
      assertionScore: assertionScoreFinal,
      assertionResults: unifiedAssertionResults,
      feedback: scores.feedback,
      threadId: currentThreadId,
      evaluatorThreadId: evaluatorResult.runId,
      durationMs,
      outputTokens,
      toolCallCount,
    });
  }

  return {
    status: passed ? "passed" : "failed",
    score: overallScore,
    dimensionScores: finalDimensionScores,
    assertionScore: assertionScoreFinal,
    assertionResults: unifiedAssertionResults,
    feedback: scores.feedback,
    durationMs,
    outputTokens,
    threadId: currentThreadId,
  };
}

// ─── Error helper ───────────────────────────────────────────────────

async function writeErrorResult(
  input: RunEvalCaseInput,
  startMs: number,
  errorMessage: string,
  targetRunId?: string,
  evaluatorRunId?: string,
  deterministicDetails?: {
    assertionScore?: number | null;
    assertionResults?: import("@/lib/assertions").AssertionResult[];
    durationMs?: number;
    outputTokens?: number;
    toolCallCount?: number;
  },
): Promise<void> {
  if (!input.runId) return;
  try {
    const errorAssertionResults: import("@/lib/assertions").AssertionResult[] = [
      ...(deterministicDetails?.assertionResults ?? []),
      {
        index: (deterministicDetails?.assertionResults?.length ?? 0),
        type: "error",
        ok: false,
        message: errorMessage,
      },
    ];
    await storage.writeCaseResult({
      runId: input.runId,
      caseId: input.caseId,
      status: "errored",
      error: { message: errorMessage },
      threadId: targetRunId ?? null,
      evaluatorThreadId: evaluatorRunId ?? null,
      assertionScore: deterministicDetails?.assertionScore ?? null,
      assertionResults: errorAssertionResults,
      durationMs: deterministicDetails?.durationMs ?? (Date.now() - startMs),
      outputTokens: deterministicDetails?.outputTokens ?? null,
      toolCallCount: deterministicDetails?.toolCallCount ?? null,
    });
  } catch (err) {
    log.error(
      { runId: input.runId, caseId: input.caseId, err: err instanceof Error ? err.message : String(err) },
      "failed to write error case result",
    );
  }
}
