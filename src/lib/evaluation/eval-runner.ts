/**
 * Evaluation — single-case execution engine.
 *
 * Runs a single evaluation case end-to-end:
 *
 *   ① Target agent run: executes each conversation turn sequentially
 *      against the target agent, building up thread history.
 *   ② Deterministic checks: evaluates code-verifiable assertions
 *      (JSONPath, schema, JS expressions, tool calls, metrics) against
 *      the execution trace.
 *   ③ Evaluator agent run: if LLM assertions (llm_dim, llm_custom)
 *      are present, dispatches the evaluator agent with the full brief.
 *   ④ Verdict computation: unified decision via `determineCaseVerdict`
 *      (short-circuit on deterministic failure, min(LLM scores) >= threshold).
 *   ⑤ Storage: persists results to `eval_case_result` with self-contained
 *      `assertionResults`.
 *
 * Designed to never throw unhandled errors — all failure modes map to
 * structured `RunEvalCaseResult` envelopes.
 *
 * See docs/evaluation.md.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { runner } from "@/lib/runner";
import { readEvents } from "@/lib/runner/event-store";
import { childLogger } from "@/lib/observability/logger";
import type { EntityRunEventEntity } from "@/lib/db/schema";

import type {
  AssertionResult,
  AssertionSpec,
  LlmCustomAssertion,
  LlmDimAssertion,
} from "@/lib/assertions";
import { determineCaseVerdict } from "@/lib/assertions";
import {
  runDeterministicChecks,
  type DeterministicCheckInput,
} from "./deterministic-checks";
import { buildEvaluationBrief } from "./prompt-builder";
import { submitEvaluationScoresSchema, type SubmitEvaluationScoresSuccess } from "./runtime-tools";
import type { ToolCallSummary, ToolCallAbnormalDetail, ExecutionStats } from "./types";
import { buildToolCallAggregates, type ToolEventRow } from "@/lib/runner/tool-call-aggregator";
import { detectToolResultStatus, extractErrorMessage } from "@/lib/copilot/detect-tool-result-status";
import * as storage from "./storage";
import { getConfigNumber } from "@/lib/config";
import {
  DEFAULT_EVAL_TARGET_TIMEOUT_S,
  DEFAULT_EVAL_EVALUATOR_TIMEOUT_S,
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
  /** Optional suite-level dimension IDs (legacy fallback). */
  dimensionIds?: string[];
  /** Suite pass threshold (1-5, default 3). */
  threshold?: number;
  /** Per-turn execution timeout for the target agent in seconds. Overrides global config. */
  targetTimeoutSec?: number | null;
  /** Case conversation turns (user messages only). */
  turns: Array<{ userMessage: string }>;
  /** Case assertions (deterministic + llm_dim + llm_custom). */
  assertions: readonly AssertionSpec[];
  /** Session user ID — used as ownerId for runner dispatch. */
  ownerId: string;
  /** Suite-level literal variables for assertion evaluation */
  variables?: Record<string, unknown>;
  /** Optional callback fired as soon as the target agent turns and tool calls complete. */
  onTargetComplete?: (info: {
    threadId: string;
    executionStats: ExecutionStats;
    toolCallSummary: ToolCallSummary;
  }) => void | Promise<void>;
  /**
   * Optional cancellation (e.g. playground client disconnected). Checked at
   * phase boundaries only — an in-flight `runner.start` is not interrupted.
   */
  signal?: AbortSignal;
}

export interface RunEvalCaseResult {
  status: "passed" | "failed" | "errored";
  assertionResults?: AssertionResult[];
  feedback?: string | null;
  error?: string;
  executionStats?: ExecutionStats;
  threadId?: string;
  toolCallSummary?: ToolCallSummary;
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

/** Extract detailed tool calls (with parsed arguments) from entity_run_event rows. */
export function extractDetailedToolCalls(
  events: EntityRunEventEntity[],
): Array<{ name: string; args?: unknown }> {
  // CONTRACT: Preserves invocation ordering and coalesces streamed tool_call_chunk args per toolCallId.
  const buckets = new Map<string, { toolName: string; argsParts: string[]; parsedArgs?: unknown }>();
  let anonymousCounter = 0;

  for (const evt of events) {
    if (evt.type !== "tool_call_chunk") continue;
    const payload = evt.payload as {
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
    } | null;

    if (!payload?.toolName) continue;
    const callId = payload.toolCallId || `anonymous_${anonymousCounter++}`;
    let bucket = buckets.get(callId);
    if (!bucket) {
      bucket = { toolName: payload.toolName, argsParts: [] };
      buckets.set(callId, bucket);
    }

    if (typeof payload.args === "string") {
      bucket.argsParts.push(payload.args);
    } else if (payload.args !== undefined && payload.args !== null) {
      bucket.parsedArgs = payload.args;
    }
  }

  const calls: Array<{ name: string; args?: unknown }> = [];
  for (const bucket of buckets.values()) {
    let args: unknown = bucket.parsedArgs;
    if (args === undefined && bucket.argsParts.length > 0) {
      const concatenated = bucket.argsParts.join("");
      try {
        args = JSON.parse(concatenated);
      } catch {
        args = concatenated;
      }
    }
    calls.push({
      name: bucket.toolName,
      args,
    });
  }

  return calls;
}

/**
 * Analyze all tool call chunks and results across conversation turns.
 * Identifies total calls, failures, security policy blocks (e.g. G20 Headless Deny),
 * invocation frequencies per tool, and abnormal execution details.
 */
export function analyzeToolCallEvents(events: EntityRunEventEntity[]): ToolCallSummary {
  const toolRows: ToolEventRow[] = events
    .filter((e) => e.type === "tool_call_chunk" || e.type === "tool_call_result")
    .map((e) => ({
      runId: e.runId,
      seq: e.seq,
      type: e.type,
      ts: e.ts,
      payload: e.payload,
    }));

  const aggregates = buildToolCallAggregates(toolRows);
  const toolFrequency: Record<string, number> = {};
  const toolDurations: Record<string, number> = {};
  const abnormalDetails: ToolCallAbnormalDetail[] = [];
  let totalCalls = 0;
  let failureCount = 0;
  let blockedCount = 0;
  let totalDurationMs = 0;

  for (const agg of aggregates.values()) {
    const toolName = agg.toolName || "unknown_tool";
    totalCalls++;
    toolFrequency[toolName] = (toolFrequency[toolName] || 0) + 1;

    let callDurationMs: number | undefined;
    if (agg.startedAt && agg.endedAt) {
      const dur = new Date(agg.endedAt).getTime() - new Date(agg.startedAt).getTime();
      if (!isNaN(dur) && dur >= 0) {
        callDurationMs = dur;
        totalDurationMs += dur;
        toolDurations[toolName] = (toolDurations[toolName] || 0) + dur;
      }
    }

    if (agg.resultContent) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(agg.resultContent);
      } catch {
        parsed = null;
      }

      // Check if blocked by security policy (G20 Headless Deny, etc.)
      const isBlocked = Boolean(
        parsed &&
          typeof parsed === "object" &&
          ((parsed as { code?: string }).code === "POLICY_DENIED" ||
            (parsed as { code?: string }).code === "TOOL_HEADLESS_DENIED" ||
            (parsed as { details?: { code?: string } }).details?.code === "POLICY_DENIED" ||
            (parsed as { details?: { code?: string } }).details?.code === "TOOL_HEADLESS_DENIED" ||
            (parsed as { error?: string }).error === "POLICY_DENIED" ||
            (parsed as { error?: string }).error === "TOOL_HEADLESS_DENIED"),
      );

      if (isBlocked) {
        blockedCount++;
        const reason =
          parsed && typeof (parsed as { message?: string }).message === "string"
            ? (parsed as { message: string }).message
            : "Headless execution denied by policy";
        const code =
          parsed && typeof (parsed as { code?: string }).code === "string"
            ? (parsed as { code: string }).code
            : parsed && typeof (parsed as { details?: { code?: string } }).details?.code === "string"
              ? (parsed as { details: { code: string } }).details.code
              : parsed && typeof (parsed as { error?: string }).error === "string"
                ? (parsed as { error: string }).error
                : "POLICY_DENIED";
        abnormalDetails.push({
          toolName,
          status: "blocked",
          durationMs: callDurationMs,
          code,
          reason,
        });
      } else {
        const status = detectToolResultStatus(agg.resultContent);
        if (status === "failure") {
          failureCount++;
          const reason = extractErrorMessage(agg.resultContent) || "Tool execution failed";
          const code =
            parsed && typeof (parsed as { code?: string }).code === "string"
              ? (parsed as { code: string }).code
              : parsed && typeof (parsed as { error?: string }).error === "string"
                ? (parsed as { error: string }).error
                : undefined;
          abnormalDetails.push({
            toolName,
            status: "failed",
            durationMs: callDurationMs,
            code,
            reason,
          });
        }
      }
    }
  }

  return {
    totalCalls,
    failureCount,
    blockedCount,
    toolFrequency,
    totalDurationMs,
    toolDurations,
    abnormalDetails,
  };
}

/** Format conversation history for prompt injection. */
function buildConversationText(
  turns: { role: "user" | "assistant"; content: string }[],
): string {
  return turns
    .map((t) => `[${t.role.toUpperCase()}]\n${t.content}`)
    .join("\n\n");
}

export const EVAL_CANCELLED_MESSAGE = "Cancelled: client disconnected before the run finished";

/** CONTRACT: cancellation is `errored` (never a graded failure) and writes no DB rows. */
function cancelledResult(
  extra: Pick<RunEvalCaseResult, "threadId" | "executionStats" | "toolCallSummary"> = {},
): RunEvalCaseResult {
  return { status: "errored", error: EVAL_CANCELLED_MESSAGE, ...extra };
}

/** Timeout wrapper for runner.start dispatches. */
async function withStepTimeout<T>(
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

/** Scan raw specs for judge-dependent items. */
function judgeAssertionsFromSpecs(
  assertions: readonly AssertionSpec[],
): Array<{ index: number; spec: LlmDimAssertion | LlmCustomAssertion }> {
  const out: Array<{ index: number; spec: LlmDimAssertion | LlmCustomAssertion }> = [];
  for (let i = 0; i < assertions.length; i += 1) {
    const a = assertions[i];
    if (a.type === "llm_dim" || a.type === "llm_custom") {
      out.push({ index: i, spec: a as (LlmDimAssertion | LlmCustomAssertion) });
    }
  }
  return out;
}

/** Parse the evaluator's submit_evaluation_scores tool call from entity_run_event. */
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
          { event: "evaluator_scores_schema_validation_failed", error: validation.error.format() },
          "evaluator submit_evaluation_scores payload failed schema validation",
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

/**
 * Remap evaluator item_scores:
 * The prompt builder presents sequential 0-based check items ([CHECK ITEM 0], [CHECK ITEM 1], ...).
 * If the evaluator returned sequential 0-based relative indices (0..judgeSpecs.length-1),
 * map them back to the original assertion indices (judgeSpecs[k].index).
 * If the evaluator returned original assertion indices directly, preserve them.
 */
function remapEvaluatorScores(
  rawScores: Array<{ index: number; score: number; reason: string }> | undefined,
  judgeSpecs: Array<{ index: number; spec: LlmDimAssertion | LlmCustomAssertion }>,
): Array<{ index: number; score: number; reason: string }> | undefined {
  if (!rawScores || judgeSpecs.length === 0) return rawScores;

  const originalIndices = new Set(judgeSpecs.map((s) => s.index));
  const isIdentity = judgeSpecs.every((s, k) => s.index === k);
  const allMatchOriginal = rawScores.every((s) => originalIndices.has(s.index));

  if (isIdentity || allMatchOriginal) {
    return rawScores;
  }

  return rawScores.map((s) => {
    const original = judgeSpecs[s.index];
    return {
      ...s,
      index: original !== undefined ? original.index : s.index,
    };
  });
}

// ─── Main ───────────────────────────────────────────────────────────

export async function runEvalCase(
  input: RunEvalCaseInput,
): Promise<RunEvalCaseResult> {
  const startMs = Date.now();
  const threshold = input.threshold ?? 3;

  // Target agent turn timeout is defined by the suite specification (defaulting to 300s code fallback)
  const targetTimeoutSec =
    typeof input.targetTimeoutSec === "number" && input.targetTimeoutSec > 0
      ? input.targetTimeoutSec
      : DEFAULT_EVAL_TARGET_TIMEOUT_S;
  const targetTimeoutMs = targetTimeoutSec * 1000;

  const evaluatorTimeoutSec = getConfigNumber(CONFIG_KEY_EVALUATOR_TIMEOUT, DEFAULT_EVAL_EVALUATOR_TIMEOUT_S);
  const evaluatorTimeoutMs = (evaluatorTimeoutSec > 0 ? evaluatorTimeoutSec : DEFAULT_EVAL_EVALUATOR_TIMEOUT_S) * 1000;

  const targetEntityKind: "agent" | "team" | "workflow" | undefined =
    input.agentSource === "builtin" ? undefined : (input.targetEntityKind ?? "agent");

  const assertions = input.assertions ?? [];
  const judgeSpecs = judgeAssertionsFromSpecs(assertions);

  // ── Pre-flight: evaluator-dependent case without an evaluator ─────────
  if (!input.evaluatorAgentId && judgeSpecs.length > 0 && judgeSpecs.length === assertions.length) {
    const verdict = determineCaseVerdict({
      assertions,
      deterministicResults: [],
      evaluatorConfigured: false,
      threshold,
    });

    const executionStats: ExecutionStats = {
      durationMs: Date.now() - startMs,
      outputChars: 0,
      ttftMs: null,
    };

    if (input.runId) {
      await storage.writeCaseResult({
        runId: input.runId,
        caseId: input.caseId,
        status: "errored",
        assertionResults: verdict.assertionResults,
        feedback: verdict.feedback,
        threadId: null,
        evaluatorThreadId: null,
        executionStats,
        toolCallSummary: null,
        error: { message: "No evaluator agent configured on suite", source: "config" },
      });
    }

    return {
      status: "errored",
      assertionResults: verdict.assertionResults,
      feedback: verdict.feedback,
      error: "No evaluator agent configured on suite",
      executionStats,
    };
  }

  // ── ① Dispatch target agent ───────────────────────────────────

  const currentThreadId = randomUUID();
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let durationMs = 0;
  let outputChars = 0;
  const actualToolCalls: string[] = [];
  let finalTargetSummary = "";
  const allTargetEvents: EntityRunEventEntity[] = [];

  for (const turn of input.turns) {
    if (input.signal?.aborted) return cancelledResult({ threadId: currentThreadId });
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
      return { status: "errored", error: message, threadId: currentThreadId };
    }

    if (targetResult.status === "failed") {
      const message = targetResult.errorMessage ?? "Target agent run failed";
      log.warn(
        { event: "target_run_failed", runId: input.runId, caseId: input.caseId, targetRunId: targetResult.runId },
        message,
      );
      await writeErrorResult(input, startMs, message, currentThreadId);
      return { status: "errored", error: message, threadId: currentThreadId };
    }

    finalTargetSummary = targetResult.summary;

    const targetEvents = await readEvents(targetResult.runId);
    allTargetEvents.push(...targetEvents);
    actualToolCalls.push(...extractToolCallNames(targetEvents));
    outputChars += targetResult.summary.length;

    history.push({ role: "user", content: turn.userMessage });
    history.push({ role: "assistant", content: targetResult.summary });
  }

  durationMs = Date.now() - startMs;
  const executionStats: ExecutionStats = {
    durationMs,
    outputChars,
    ttftMs: null,
  };
  const toolCallSummary = analyzeToolCallEvents(allTargetEvents);
  const toolCallCount = toolCallSummary.totalCalls;

  if (input.onTargetComplete) {
    try {
      await input.onTargetComplete({
        threadId: currentThreadId,
        executionStats,
        toolCallSummary,
      });
    } catch (cbErr) {
      log.warn(
        { err: cbErr instanceof Error ? cbErr.message : String(cbErr), caseId: input.caseId },
        "onTargetComplete callback failed",
      );
    }
  }

  // ── ② Deterministic checks ───────────────────────────────────

  const checkInput: DeterministicCheckInput = {
    agentText: finalTargetSummary,
    actualToolCalls,
    toolCalls: extractDetailedToolCalls(allTargetEvents),
    metrics: { durationMs, outputChars, toolCallCount },
    variables: input.variables,
    toolCallSummary,
  };
  const checks = runDeterministicChecks(assertions, checkInput);

  // ── Fail-Fast: if deterministic checks failed, short-circuit ─
  const hasDeterministicFailure =
    checks.totalCount > 0 && checks.passedCount < checks.totalCount;

  if (hasDeterministicFailure) {
    const verdict = determineCaseVerdict({
      assertions,
      deterministicResults: checks.assertionResults,
      threshold,
    });

    if (input.runId) {
      await storage.writeCaseResult({
        runId: input.runId,
        caseId: input.caseId,
        status: verdict.status,
        assertionResults: verdict.assertionResults,
        feedback: verdict.feedback,
        threadId: currentThreadId,
        evaluatorThreadId: null,
        executionStats,
        toolCallSummary,
      });
    }

    return {
      status: verdict.status,
      assertionResults: verdict.assertionResults,
      feedback: verdict.feedback,
      executionStats,
      threadId: currentThreadId,
      toolCallSummary,
    };
  }

  // ── No evaluator agent configured ──────────────────────────────
  if (!input.evaluatorAgentId) {
    const verdict = determineCaseVerdict({
      assertions,
      deterministicResults: checks.assertionResults,
      evaluatorConfigured: false,
      threshold,
    });

    if (input.runId) {
      await storage.writeCaseResult({
        runId: input.runId,
        caseId: input.caseId,
        status: verdict.status,
        assertionResults: verdict.assertionResults,
        feedback: verdict.feedback,
        threadId: currentThreadId,
        evaluatorThreadId: null,
        executionStats,
        toolCallSummary,
      });
    }

    return {
      status: verdict.status,
      assertionResults: verdict.assertionResults,
      feedback: verdict.feedback,
      executionStats,
      threadId: currentThreadId,
      toolCallSummary,
    };
  }

  // Pure deterministic case (no LLM assertions)
  if (checks.llmAssertions.length === 0) {
    const verdict = determineCaseVerdict({
      assertions,
      deterministicResults: checks.assertionResults,
      threshold,
    });

    if (input.runId) {
      await storage.writeCaseResult({
        runId: input.runId,
        caseId: input.caseId,
        status: verdict.status,
        assertionResults: verdict.assertionResults,
        feedback: verdict.feedback,
        threadId: currentThreadId,
        evaluatorThreadId: null,
        executionStats,
        toolCallSummary,
      });
    }

    return {
      status: verdict.status,
      assertionResults: verdict.assertionResults,
      feedback: verdict.feedback,
      executionStats,
      threadId: currentThreadId,
      toolCallSummary,
    };
  }

  // ── ③ Assemble evaluator prompt ──────────────────────────────

  if (input.signal?.aborted) {
    return cancelledResult({ threadId: currentThreadId, executionStats, toolCallSummary });
  }

  const conversationText = buildConversationText(history);
  const brief = buildEvaluationBrief({
    dimensionIds: input.dimensionIds,
    assertions,
    checkResults: checks.results,
    conversationText,
    toolCallSummary,
  });

  // ── ④ Dispatch evaluator agent (with retry) ──────────────────

  let evaluatorResult;
  let scores: SubmitEvaluationScoresSuccess | null = null;
  let retries = 0;
  let lastError = "";

  while (retries < 2) {
    if (retries > 0 && input.signal?.aborted) {
      return cancelledResult({ threadId: currentThreadId, executionStats, toolCallSummary });
    }
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

  // ── ⑤ Compute final verdict via unified verdict engine ────────

  const verdict = determineCaseVerdict({
    assertions,
    deterministicResults: checks.assertionResults,
    llmScores: remapEvaluatorScores(scores?.item_scores, judgeSpecs),
    evaluatorConfigured: true,
    evaluatorError: !scores ? (lastError || "Evaluator failed to return scores after retries") : undefined,
    threshold,
    evaluatorFeedback: scores?.feedback,
  });

  if (input.runId) {
    await storage.writeCaseResult({
      runId: input.runId,
      caseId: input.caseId,
      status: verdict.status,
      assertionResults: verdict.assertionResults,
      feedback: verdict.feedback,
      threadId: currentThreadId,
      evaluatorThreadId: evaluatorResult?.runId ?? null,
      executionStats,
      toolCallSummary,
    });
  }

  return {
    status: verdict.status,
    assertionResults: verdict.assertionResults,
    feedback: verdict.feedback,
    executionStats,
    threadId: currentThreadId,
    toolCallSummary,
    error: !scores ? (lastError || "Evaluator did not call submit_evaluation_scores") : undefined,
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
    assertionResults?: AssertionResult[];
    executionStats?: ExecutionStats;
    toolCallSummary?: ToolCallSummary;
  },
): Promise<void> {
  if (!input.runId) return;
  try {
    const errorAssertionResults: AssertionResult[] = [
      ...(deterministicDetails?.assertionResults ?? []),
      {
        index: (deterministicDetails?.assertionResults?.length ?? 0),
        type: "error",
        ok: false,
        message: errorMessage,
        errored: true,
      },
    ];
    const executionStats: ExecutionStats = deterministicDetails?.executionStats ?? {
      durationMs: Date.now() - startMs,
      outputChars: 0,
      ttftMs: null,
    };
    await storage.writeCaseResult({
      runId: input.runId,
      caseId: input.caseId,
      status: "errored",
      error: { message: errorMessage },
      threadId: targetRunId ?? null,
      evaluatorThreadId: evaluatorRunId ?? null,
      assertionResults: errorAssertionResults,
      executionStats,
      toolCallSummary: deterministicDetails?.toolCallSummary ?? null,
    });
  } catch (err) {
    log.error(
      { runId: input.runId, caseId: input.caseId, err: err instanceof Error ? err.message : String(err) },
      "failed to write error case result",
    );
  }
}
