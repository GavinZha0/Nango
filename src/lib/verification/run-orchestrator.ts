/**
 * Verification — suite-level execution orchestrator.
 *
 * Public entry: {@link startSuiteRun}, {@link startGroupRun}. Returns a `runId` immediately
 * and runs the suite asynchronously in the background. The Node
 * single-threaded event loop guarantees this co-operates with HTTP
 * handlers; we never `await` the inner loop from the API caller.
 *
 * Invariants (see docs/verification.md):
 *
 *   - Serial, alphabetical by case name
 *   - Failure-tolerant: errored/failed cases do NOT abort
 *   - SSE frames published per case + at start/end
 *   - MCP cases only
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { VerificationGroupTable } from "@/lib/db/schema";
import { recordRunNotification } from "@/lib/runner/notifications";
import { publishVerificationFrame } from "./event-bus-channel";
import { runMcpCase } from "./runner-mcp";
import { resolveEffectiveToolName } from "./tool-name";
import * as storage from "./storage";
import {
  extractMcpStructuredData,
  registerCaseInSuiteContext,
} from "@/lib/verification/resolve-input";
import { resolveSuiteVariables } from "@/lib/testing/variable-resolver.server";
import type {
  AssertionSpec,
  CaseExecutionOutcome,
  VerificationRunStatus,
} from "./types";

const log = childLogger({ component: "verification-orchestrator" });

export interface SuiteRunFinishPayload {
  status: VerificationRunStatus;
  passedCount: number;
  failedCount: number;
  erroredCount: number;
  skippedCount: number;
  runId: string;
  suiteId: string;
  groupId?: string | null;
}

export interface StartSuiteRunInput {
  suiteId: string;
  ownerId: string;
  triggeredBy: "manual" | "schedule";
  suppressNotification?: boolean;
  onFinish?: (payload: SuiteRunFinishPayload) => Promise<void> | void;
}

export interface StartSuiteRunResult {
  runId: string;
  totalCount: number;
}

/**
 * Kick off a suite run. Returns synchronously with the new
 * {@link verification_run} id; the actual case loop runs in the
 * background and publishes SSE frames to `ownerId`'s channel.
 */
export async function startSuiteRun(
  input: StartSuiteRunInput,
): Promise<StartSuiteRunResult> {
  const suite = await storage.getSuiteById(input.suiteId);
  if (!suite) throw new Error(`verification suite not found: ${input.suiteId}`);

  const cases = await storage.listEnabledCasesForRun(input.suiteId);
  const run = await storage.createRun({
    suiteId: input.suiteId,
    totalCount: cases.length,
    triggeredBy: input.triggeredBy,
  });

  publishVerificationFrame(input.ownerId, {
    topic: "verification_run",
    kind: "run_started",
    runId: run.id,
    suiteId: input.suiteId,
    suiteName: suite.name,
    totalCount: cases.length,
  });

  // Empty suite: finalise immediately with passed=0/total=0.
  if (cases.length === 0) {
    await storage.finalizeRun({
      runId: run.id,
      status: "passed",
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 0,
    });
    publishVerificationFrame(input.ownerId, {
      topic: "verification_run",
      kind: "run_finished",
      runId: run.id,
      status: "passed",
      totalCount: 0,
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 0,
    });
    if (input.onFinish) {
      await input.onFinish({
        status: "passed",
        passedCount: 0,
        failedCount: 0,
        erroredCount: 0,
        skippedCount: 0,
        runId: run.id,
        suiteId: input.suiteId,
        groupId: suite.groupId,
      });
    }
    return { runId: run.id, totalCount: 0 };
  }

  // Fire-and-forget background loop.
  void executeSuiteLoop({
    runId: run.id,
    suiteId: input.suiteId,
    groupId: suite.groupId,
    ownerId: input.ownerId,
    targetName: suite.name,
    cases,
    suppressNotification: input.suppressNotification,
    onFinish: input.onFinish,
  });

  return { runId: run.id, totalCount: cases.length };
}

export interface StartGroupRunInput {
  groupId: string;
  ownerId: string;
  viewer: storage.VerificationViewer;
  triggeredBy?: "manual" | "schedule";
}

export interface StartGroupRunResult {
  groupId: string;
  triggeredCount: number;
  skippedCount: number;
  runIds: string[];
}

/**
 * Kick off a group run across all visible enabled suites in the specified group.
 * Gathers suites using listEnabledSuitesByGroup(groupId, viewer) to strictly prevent F6 privilege escalation.
 */
export async function startGroupRun(
  input: StartGroupRunInput,
): Promise<StartGroupRunResult> {
  const suites = await storage.listEnabledSuitesByGroup(
    input.groupId,
    input.viewer,
  );
  const runIds: string[] = [];

  const [groupRow] = await db
    .select()
    .from(VerificationGroupTable)
    .where(eq(VerificationGroupTable.id, input.groupId))
    .limit(1);
  const groupName = groupRow?.name ?? "Verification Group";

  if (suites.length === 0) {
    return {
      groupId: input.groupId,
      triggeredCount: 0,
      skippedCount: 0,
      runIds: [],
    };
  }

  let finishedSuites = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalErrored = 0;
  let totalSkipped = 0;
  let anyFailure = false;

  const onSuiteFinish = async (payload: SuiteRunFinishPayload) => {
    finishedSuites += 1;
    totalPassed += payload.passedCount;
    totalFailed += payload.failedCount;
    totalErrored += payload.erroredCount;
    totalSkipped += payload.skippedCount;
    if (payload.status !== "passed") {
      anyFailure = true;
    }

    if (finishedSuites === suites.length) {
      // Single aggregated notification with runId: null
      await recordRunNotification({
        ownerId: input.ownerId,
        runId: null,
        kind: anyFailure ? "run_failed" : "run_completed",
        title: `Verification Group: ${groupName}`,
        body: anyFailure
          ? `Group completed with issues: ✓ ${totalPassed} Passed, ✗ ${totalFailed} Failed, ${totalErrored} Errored, ${totalSkipped} Skipped (${suites.length} suites)`
          : `All ${suites.length} suites passed: ✓ ${totalPassed} Passed`,
        sourceLabel: "Verification Group",
        task: `Run verification group '${groupName}'`,
        initiator: "verification",
      });
    }
  };

  for (const suite of suites) {
    try {
      const res = await startSuiteRun({
        suiteId: suite.id,
        ownerId: input.ownerId,
        triggeredBy: input.triggeredBy ?? "manual",
        suppressNotification: true,
        onFinish: onSuiteFinish,
      });
      runIds.push(res.runId);
    } catch (err) {
      log.error(
        {
          event: "start_group_suite_failed",
          suiteId: suite.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to start suite run in group",
      );
    }
  }

  return {
    groupId: input.groupId,
    triggeredCount: runIds.length,
    skippedCount: suites.length - runIds.length,
    runIds,
  };
}

interface ExecuteSuiteLoopInput {
  runId: string;
  suiteId: string;
  groupId?: string | null;
  ownerId: string;
  targetName: string;
  cases: Awaited<ReturnType<typeof storage.listEnabledCasesForRun>>;
  suppressNotification?: boolean;
  onFinish?: (payload: SuiteRunFinishPayload) => Promise<void> | void;
}

interface LoopCounters {
  passedCount: number;
  failedCount: number;
  erroredCount: number;
  skippedCount: number;
}

async function executeSuiteLoop(input: ExecuteSuiteLoopInput): Promise<void> {
  const counters: LoopCounters = {
    passedCount: 0,
    failedCount: 0,
    erroredCount: 0,
    skippedCount: 0,
  };

  try {
    await runSuiteCases(input, counters);
    await finaliseAndAnnounce(input, counters);
  } catch (err) {
    await handleSuiteLoopCrash(input, counters, err);
  }
}

async function runSuiteCases(
  input: ExecuteSuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  let currentSuiteId: string | null = null;
  let suiteContext: Record<string, unknown> = {};
  let suiteLiteralVariables: Record<string, unknown> = {};
  let suiteResolveError: { source: "config"; message: string } | null = null;

  for (const c of input.cases) {
    if (c.suiteId !== currentSuiteId) {
      currentSuiteId = c.suiteId;
      suiteContext = {};
      const { literalVariables, error } = await resolveSuiteVariables(
        c.suiteVariables,
        { allowCredentials: false },
      );
      suiteLiteralVariables = literalVariables;
      suiteResolveError = error;
    }

    if (suiteResolveError) {
      const outcome: CaseExecutionOutcome = {
        status: "errored",
        resolvedInput: (c.input ?? {}) as Record<string, unknown>,
        resultPayload: null,
        resultTruncated: false,
        assertionResults: [],
        error: suiteResolveError,
        startedAt: Date.now(),
        durationMs: 0,
      };
      await persistAndPublish({
        ownerId: input.ownerId,
        runId: input.runId,
        caseId: c.id,
        outcome,
        originalToolName: c.toolName ?? "",
        effectiveToolName: c.toolName ?? "",
      });
      counters.erroredCount += 1;
      continue;
    }

    if (!c.mcpServerId || !c.toolName) {
      const outcome: CaseExecutionOutcome = {
        status: "errored",
        resolvedInput: (c.input ?? {}) as Record<string, unknown>,
        resultPayload: null,
        resultTruncated: false,
        assertionResults: [],
        error: {
          source: "internal",
          message: "MCP case missing mcpServerId or toolName",
          details: { caseId: c.id },
        },
        startedAt: Date.now(),
        durationMs: 0,
      };
      await persistAndPublish({
        ownerId: input.ownerId,
        runId: input.runId,
        caseId: c.id,
        outcome,
        originalToolName: c.toolName ?? "",
        effectiveToolName: c.toolName ?? "",
      });
      counters.erroredCount += 1;
      continue;
    }

    const effectiveToolName = resolveEffectiveToolName(
      c.toolName ?? "",
      c.toolPrefixRule,
    );

    const outcome: CaseExecutionOutcome = await runMcpCase(
      {
        mcpServerId: c.mcpServerId!,
        toolName: effectiveToolName,
        input: (c.input ?? {}) as Record<string, unknown>,
        assertions: (c.assertions ?? []) as readonly AssertionSpec[],
        originalToolName: c.toolName ?? "",
        serverName: c.mcpServerName ?? "",
        rule: c.toolPrefixRule ?? null,
        caseTimeoutSec: c.caseTimeoutSec ?? null,
      },
      { cases: suiteContext, variables: suiteLiteralVariables },
    );

    await persistAndPublish({
      ownerId: input.ownerId,
      runId: input.runId,
      caseId: c.id,
      outcome,
      originalToolName: c.toolName ?? "",
      effectiveToolName,
    });

    const structured = extractMcpStructuredData(outcome.resultPayload);
    const outputData =
      structured !== undefined && structured !== null
        ? structured
        : (outcome.resultPayload ?? {});

    registerCaseInSuiteContext(suiteContext, c.name, {
      input: outcome.resolvedInput ?? {},
      output: outputData,
    });

    if (outcome.status === "passed") counters.passedCount += 1;
    else if (outcome.status === "failed") counters.failedCount += 1;
    else if (outcome.status === "errored") counters.erroredCount += 1;
    else if (outcome.status === "skipped") counters.skippedCount += 1;
  }
}

async function finaliseAndAnnounce(
  input: ExecuteSuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  let finalStatus: VerificationRunStatus = computeFinalStatus({
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
  });

  const title = `Verification: ${input.targetName}`;
  const sourceLabel = "Verification Suite";
  const task = `Run verification suite '${input.targetName}'`;

  let finalizedInDb = false;
  try {
    await storage.finalizeRun({
      runId: input.runId,
      status: finalStatus,
      passedCount: counters.passedCount,
      failedCount: counters.failedCount,
      erroredCount: counters.erroredCount,
      skippedCount: counters.skippedCount,
    });
    finalizedInDb = true;
  } catch (err) {
    log.error(
      {
        event: "verification_finalize_failed",
        runId: input.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to finalise verification run; will be swept on next boot",
    );
    // CONTRACT: If DB finalize fails, the run is not persisted as completed.
    // Downgrade status so clients never observe a phantom passed run.
    finalStatus = "errored";
  }

  if (!input.suppressNotification) {
    try {
      await recordRunNotification({
        ownerId: input.ownerId,
        runId: input.runId,
        kind: finalStatus === "passed" ? "run_completed" : "run_failed",
        title,
        body: finalizedInDb
          ? `✓ ${counters.passedCount} Passed, ✗ ${counters.failedCount} Failed, ${counters.erroredCount} Errored, ${counters.skippedCount} Skipped`
          : `Storage error: failed to finalize verification run in database`,
        sourceLabel,
        task,
        initiator: "verification",
      });
    } catch (notifErr) {
      log.error(
        {
          event: "verification_notification_failed",
          runId: input.runId,
          err: notifErr instanceof Error ? notifErr.message : String(notifErr),
        },
        "failed to record verification notification",
      );
    }
  }

  if (input.onFinish) {
    try {
      await input.onFinish({
        status: finalStatus,
        passedCount: counters.passedCount,
        failedCount: counters.failedCount,
        erroredCount: counters.erroredCount,
        skippedCount: counters.skippedCount,
        runId: input.runId,
        suiteId: input.suiteId,
        groupId: input.groupId,
      });
    } catch (finishErr) {
      log.error(
        {
          event: "verification_onfinish_failed",
          runId: input.runId,
          err: finishErr instanceof Error ? finishErr.message : String(finishErr),
        },
        "failed in verification onFinish callback",
      );
    }
  }

  publishVerificationFrame(input.ownerId, {
    topic: "verification_run",
    kind: "run_finished",
    runId: input.runId,
    status: finalStatus,
    totalCount: input.cases.length,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
    skippedCount: counters.skippedCount,
  });
}

async function handleSuiteLoopCrash(
  input: ExecuteSuiteLoopInput,
  counters: LoopCounters,
  err: unknown,
): Promise<void> {
  log.error(
    {
      event: "verification_suite_loop_crashed",
      runId: input.runId,
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
    "verification suite loop crashed; forcing errored terminal state",
  );

  const title = `Verification: ${input.targetName}`;
  const sourceLabel = "Verification Suite";
  const task = `Run verification suite '${input.targetName}'`;

  try {
    await storage.finalizeRun({
      runId: input.runId,
      status: "errored",
      passedCount: counters.passedCount,
      failedCount: counters.failedCount,
      erroredCount: counters.erroredCount + 1,
      skippedCount: counters.skippedCount,
    });
  } catch (dbErr) {
    log.error(
      {
        event: "verification_finalize_on_crash_failed",
        runId: input.runId,
        err: dbErr instanceof Error ? dbErr.message : String(dbErr),
      },
      "failed to finalize verification run on crash",
    );
  }

  if (!input.suppressNotification) {
    try {
      await recordRunNotification({
        ownerId: input.ownerId,
        runId: input.runId,
        kind: "run_failed",
        title,
        body: `Crashed: ${err instanceof Error ? err.message : String(err)}`,
        sourceLabel,
        task,
        initiator: "verification",
      });
    } catch (notifErr) {
      log.error(
        {
          event: "verification_notification_on_crash_failed",
          runId: input.runId,
          err: notifErr instanceof Error ? notifErr.message : String(notifErr),
        },
        "failed to record notification on crash",
      );
    }
  }

  if (input.onFinish) {
    try {
      await input.onFinish({
        status: "errored",
        passedCount: counters.passedCount,
        failedCount: counters.failedCount,
        erroredCount: counters.erroredCount + 1,
        skippedCount: counters.skippedCount,
        runId: input.runId,
        suiteId: input.suiteId,
        groupId: input.groupId,
      });
    } catch (finishErr) {
      log.error(
        {
          event: "verification_onfinish_on_crash_failed",
          runId: input.runId,
          err: finishErr instanceof Error ? finishErr.message : String(finishErr),
        },
        "failed in onFinish on crash",
      );
    }
  }

  publishVerificationFrame(input.ownerId, {
    topic: "verification_run",
    kind: "run_finished",
    runId: input.runId,
    status: "errored",
    totalCount: input.cases.length,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount + 1,
    skippedCount: counters.skippedCount,
  });
}

function computeFinalStatus(args: {
  passedCount: number;
  failedCount: number;
  erroredCount: number;
}): VerificationRunStatus {
  if (args.erroredCount > 0) return "errored";
  if (args.failedCount > 0) return "failed";
  return "passed";
}

interface PersistAndPublishInput {
  ownerId: string;
  runId: string;
  caseId: number;
  outcome: CaseExecutionOutcome;
  originalToolName?: string | null;
  effectiveToolName?: string | null;
}

const WRITE_RESULT_MAX_ATTEMPTS = 3;
const WRITE_RESULT_RETRY_BASE_MS = 50;

// CONTRACT: Persisting case result must succeed before case_finished event is emitted
// or counter incremented. Storage failure stops execution and marks the run as errored.
async function persistAndPublish(input: PersistAndPublishInput): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= WRITE_RESULT_MAX_ATTEMPTS; attempt++) {
    try {
      await storage.writeCaseResult({
        runId: input.runId,
        caseId: input.caseId,
        outcome: input.outcome,
        inputSnapshot: input.outcome.resolvedInput,
        originalToolName: input.originalToolName,
        effectiveToolName: input.effectiveToolName,
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < WRITE_RESULT_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, WRITE_RESULT_RETRY_BASE_MS * attempt),
        );
      }
    }
  }

  if (lastError) {
    log.error(
      {
        event: "verification_case_persist_failed",
        runId: input.runId,
        caseId: input.caseId,
        err: lastError instanceof Error ? lastError.message : String(lastError),
      },
      "failed to persist verification_case_result after retries",
    );
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  publishVerificationFrame(input.ownerId, {
    topic: "verification_run",
    kind: "case_finished",
    runId: input.runId,
    caseId: input.caseId,
    status: input.outcome.status,
    durationMs: input.outcome.durationMs,
    error: input.outcome.error ?? undefined,
  });
}
