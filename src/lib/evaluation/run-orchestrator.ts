/**
 * Evaluation — suite-level execution orchestrator.
 *
 * Public entry: {@link startEvalSuiteRun}. Returns a `runId`
 * immediately and runs the suite asynchronously in the background.
 * Mirrors `verification/run-orchestrator.ts`.
 *
 * Invariants (see docs/evaluation.md):
 *   - Serial, alphabetical by case name
 *   - Failure-tolerant: errored/failed cases do NOT abort
 *   - SSE frames published per case + at start/end
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import { publish } from "@/lib/runner/event-bus";
import { runEvalCase, type RunEvalCaseResult } from "./eval-runner";
import { recordRunNotification } from "@/lib/runner/notifications";
import * as storage from "./storage";
import type { EvalCriteria, EvalTurn } from "./types";

const log = childLogger({ component: "eval-orchestrator" });

// ─── SSE frames ─────────────────────────────────────────────────────

interface EvalFrame {
  topic: "evaluation_run";
  kind: string;
  runId: string;
  [key: string]: unknown;
}

function publishEvalFrame(ownerId: string, frame: EvalFrame): void {
  publish(ownerId, { kind: "evaluation", ownerId, frame });
}

// ─── Public entry ───────────────────────────────────────────────────

export interface StartEvalSuiteRunInput {
  suiteId: string;
  ownerId: string;
  triggeredBy: "manual" | "schedule";
  caseIds?: number[]; // Optional list of specific case IDs to run
}

export interface StartEvalSuiteRunResult {
  runId: string;
  totalCount: number;
}

/**
 * Kick off an eval suite run. Returns synchronously with the new
 * `eval_run` id; the actual case loop runs in the background.
 */
export async function startEvalSuiteRun(
  input: StartEvalSuiteRunInput,
): Promise<StartEvalSuiteRunResult> {
  const suite = await storage.getSuiteById(input.suiteId);
  if (!suite) throw new Error(`eval suite not found: ${input.suiteId}`);
  if (!suite.evaluatorAgentId) {
    throw new Error("Eval suite has no evaluator agent assigned.");
  }

  const cases =
    input.caseIds && input.caseIds.length > 0
      ? await storage.listCasesByIds(input.caseIds)
      : await storage.listEnabledCasesForRun(input.suiteId);

  const run = await storage.createRun({
    suiteId: input.suiteId,
    totalCount: cases.length,
    triggeredBy: input.triggeredBy,
  });

  publishEvalFrame(input.ownerId, {
    topic: "evaluation_run",
    kind: "run_started",
    runId: run.id,
    suiteId: input.suiteId,
    suiteName: suite.name,
    totalCount: cases.length,
  });

  // Empty suite: finalise immediately.
  if (cases.length === 0) {
    await storage.finalizeRun({
      runId: run.id,
      status: "passed",
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
    });
    publishEvalFrame(input.ownerId, {
      topic: "evaluation_run",
      kind: "run_finished",
      runId: run.id,
      status: "passed",
      totalCount: 0,
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
    });
    return { runId: run.id, totalCount: 0 };
  }

  // Fire-and-forget background loop.
  void executeSuiteLoop({
    runId: run.id,
    ownerId: input.ownerId,
    suiteId: input.suiteId,
    suiteName: suite.name,
    evaluatorAgentId: suite.evaluatorAgentId,
    dimensionIds: (suite.dimensionIds ?? []) as string[],
    targetAgentId: suite.agentId,
    targetCredentialId: suite.credentialId ?? undefined,
    targetAgentSource: suite.agentSource,
    cases,
  });

  return { runId: run.id, totalCount: cases.length };
}

// ─── Background loop ────────────────────────────────────────────────

interface SuiteLoopInput {
  runId: string;
  ownerId: string;
  suiteId: string;
  suiteName: string;
  evaluatorAgentId: string;
  dimensionIds: string[];
  targetAgentId: string;
  targetCredentialId?: string;
  targetAgentSource: string;
  cases: Awaited<ReturnType<typeof storage.listEnabledCasesForRun>>;
}

interface LoopCounters {
  passedCount: number;
  failedCount: number;
  erroredCount: number;
}

async function executeSuiteLoop(input: SuiteLoopInput): Promise<void> {
  const counters: LoopCounters = {
    passedCount: 0,
    failedCount: 0,
    erroredCount: 0,
  };

  try {
    await runAllCases(input, counters);
    await finaliseAndAnnounce(input, counters);
  } catch (err) {
    await handleLoopCrash(input, counters, err);
  }
}

async function runAllCases(
  input: SuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  for (const c of input.cases) {
    let result: RunEvalCaseResult;
    try {
      result = await runEvalCase({
        runId: input.runId,
        caseId: c.id,
        targetAgentId: input.targetAgentId,
        targetCredentialId: input.targetCredentialId,
        targetEntityKind:
          input.targetAgentSource === "builtin" ? undefined : "agent",
        evaluatorAgentId: input.evaluatorAgentId,
        dimensionIds: input.dimensionIds,
        turns: (c.turns ?? []) as EvalTurn[],
        criteria: (c.criteria ?? {}) as EvalCriteria,
        ownerId: input.ownerId,
      });
    } catch (err) {
      // runEvalCase should never throw, but defend in depth.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { event: "case_unexpected_throw", runId: input.runId, caseId: c.id, err: message },
        "unexpected throw from runEvalCase",
      );
      result = { status: "errored", score: null, error: message };
    }

    if (result.status === "passed") counters.passedCount++;
    else if (result.status === "failed") counters.failedCount++;
    else counters.erroredCount++;

    publishEvalFrame(input.ownerId, {
      topic: "evaluation_run",
      kind: "case_completed",
      runId: input.runId,
      caseId: c.id,
      caseName: c.name,
      status: result.status,
      score: result.score,
      dimensionScores: result.dimensionScores,
      criteriaScore: result.criteriaScore,
      criteriaResults: result.criteriaResults,
      feedback: result.feedback,
      durationMs: result.durationMs,
      outputTokens: result.outputTokens,
    });
  }
}

async function finaliseAndAnnounce(
  input: SuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  const total = counters.passedCount + counters.failedCount + counters.erroredCount;
  const passRate = total > 0 ? Math.round((counters.passedCount / total) * 100) : 100;

  // Status precedence: errored > failed > passed.
  let status: "passed" | "failed" | "errored";
  if (counters.erroredCount > 0) status = "errored";
  else if (counters.failedCount > 0) status = "failed";
  else status = "passed";

  await storage.finalizeRun({
    runId: input.runId,
    status,
    score: passRate,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
  });

  try {
    await recordRunNotification({
      ownerId: input.ownerId,
      runId: input.runId,
      kind: status === "passed" ? "run_completed" : "run_failed",
      title: `Evaluation: ${input.suiteName}`,
      body: `Score: ${passRate}%, ✓ ${counters.passedCount} Passed, ✗ ${counters.failedCount} Failed, ${counters.erroredCount} Errored`,
      sourceLabel: "Evaluation Suite",
      task: `Run evaluation suite '${input.suiteName}'`,
      initiator: "evaluation",
    });
  } catch (notifErr) {
    log.error(
      {
        event: "evaluation_notification_failed",
        runId: input.runId,
        err: notifErr instanceof Error ? notifErr.message : String(notifErr),
      },
      "failed to record evaluation notification",
    );
  }

  publishEvalFrame(input.ownerId, {
    topic: "evaluation_run",
    kind: "run_finished",
    runId: input.runId,
    status,
    totalCount: total,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
    score: passRate,
  });

  log.info(
    {
      event: "eval_run_finished",
      runId: input.runId,
      suiteId: input.suiteId,
      status,
      passRate,
      ...counters,
    },
    `eval run finished: ${status} (${counters.passedCount}/${total} passed)`,
  );
}

async function handleLoopCrash(
  input: SuiteLoopInput,
  counters: LoopCounters,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log.error(
    { event: "eval_loop_crash", runId: input.runId, suiteId: input.suiteId, err: message },
    "eval suite loop crashed — finalising as errored",
  );

  try {
    await storage.finalizeRun({
      runId: input.runId,
      status: "errored",
      passedCount: counters.passedCount,
      failedCount: counters.failedCount,
      erroredCount: counters.erroredCount,
    });

    await recordRunNotification({
      ownerId: input.ownerId,
      runId: input.runId,
      kind: "run_failed",
      title: `Evaluation: ${input.suiteName}`,
      body: `Crashed: ${message}`,
      sourceLabel: "Evaluation Suite",
      task: `Run evaluation suite '${input.suiteName}'`,
      initiator: "evaluation",
    });
  } catch (finErr) {
    log.error(
      { runId: input.runId, err: finErr instanceof Error ? finErr.message : String(finErr) },
      "failed to finalise crashed eval run",
    );
  }

    publishEvalFrame(input.ownerId, {
    topic: "evaluation_run",
    kind: "run_finished",
    runId: input.runId,
    status: "errored",
    totalCount: input.cases.length,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
    error: message,
  });
}

export interface StartAgentAllRunsInput {
  agentId: string;
  agentSource: string;
  credentialId?: string | null;
  ownerId: string;
  /** Admin bypasses suite visibility scoping (default false). */
  isAdmin?: boolean;
  triggeredBy: "manual" | "schedule";
}

/**
 * Kick off serial runs for all enabled evaluation suites of an agent.
 */
export async function startEvalAgentAllRuns(
  input: StartAgentAllRunsInput,
): Promise<void> {
  // SECURITY: only the effective owner's visible suites run (BUG-3).
  const allSuites = await storage.listSuitesByAgent(
    input.agentId,
    input.agentSource,
    input.ownerId,
    input.isAdmin ?? false,
  );
  const runnable = allSuites.filter((s) => s.enabled && s.evaluatorAgentId);
  if (runnable.length === 0) return;

  // Background serial execution loop
  void (async () => {
    for (const suite of runnable) {
      try {
        const cases = await storage.listEnabledCasesForRun(suite.id);
        if (cases.length === 0) continue;

        const run = await storage.createRun({
          suiteId: suite.id,
          totalCount: cases.length,
          triggeredBy: input.triggeredBy,
        });

        publishEvalFrame(input.ownerId, {
          topic: "evaluation_run",
          kind: "run_started",
          runId: run.id,
          suiteId: suite.id,
          suiteName: suite.name,
          totalCount: cases.length,
        });

        await executeSuiteLoop({
          runId: run.id,
          ownerId: input.ownerId,
          suiteId: suite.id,
          suiteName: suite.name,
          evaluatorAgentId: suite.evaluatorAgentId!,
          dimensionIds: (suite.dimensionIds ?? []) as string[],
          targetAgentId: suite.agentId,
          targetCredentialId: suite.credentialId ?? undefined,
          targetAgentSource: suite.agentSource,
          cases,
        });

      } catch (err) {
        log.error(
          {
            event: "agent_all_runs_suite_failed",
            agentId: input.agentId,
            suiteId: suite.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to execute suite in agent serial loop",
        );
      }
    }
  })();
}
