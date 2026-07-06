/**
 * Verification — suite-level execution orchestrator.
 *
 * Public entry: {@link startSuiteRun}. Returns a `runId` immediately
 * and runs the suite asynchronously in the background. The Node
 * single-threaded event loop guarantees this co-operates with HTTP
 * handlers; we never `await` the inner loop from the API caller.
 *
 * Invariants (see docs/verification.md):
 *
 *   - Serial, alphabetical by case name
 *   - Failure-tolerant: errored/failed/timeout cases do NOT abort
 *   - Suite timeout marks remaining cases as `skipped`
 *   - SSE frames published per case + at start/end
 *   - V1: MCP cases only (workflow cases throw `WORKFLOW_TESTS_V2`)
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { recordRunNotification } from "@/lib/runner/notifications";
import { publishVerificationFrame } from "./event-bus-channel";
import { runMcpCase } from "./runner-mcp";
import * as storage from "./storage";
import { timeoutError } from "./error-source";
import type {
  AssertionSpec,
  CaseExecutionOutcome,
  VerificationRunStatus,
} from "./types";

const log = childLogger({ component: "verification-orchestrator" });

/**
 * Per-case wall-clock cap. Independent of the suite-level timeout —
 * a single hung `tool.execute` MUST NOT block the whole serial loop
 * indefinitely, because the suite-level check only fires between
 * cases. The MCP pool exposes no AbortSignal in V1, so the dangling
 * promise is detached (`.catch` guards against UnhandledRejection)
 * and the provider-pool's refcount / idle reaper eventually reclaims
 * the client when this case's borrow is released.
 *
 * Set generously (60 s) — most MCP tools should finish in << 1 s; a
 * minute is the threshold at which "this tool is hung" is the only
 * sensible interpretation. Callers wanting tighter bounds should
 * lower the SUITE timeout (`verification_suite.timeoutSec`).
 */
const PER_CASE_MAX_MS = 60_000;

export interface StartSuiteRunInput {
  suiteId: string;
  ownerId: string;
  triggeredBy: "manual" | "schedule";
}

export interface StartServerRunInput {
  mcpServerId: string;
  ownerId: string;
  triggeredBy: "manual" | "schedule";
}

export interface StartSuiteRunResult {
  runId: string;
  totalCount: number;
}

/**
 * Kick off a server run (runs all cases across all tools of this server).
 */
export async function startServerRun(
  input: StartServerRunInput,
): Promise<StartSuiteRunResult> {
  const [server] = await db
    .select()
    .from(McpServerTable)
    .where(eq(McpServerTable.id, input.mcpServerId))
    .limit(1);

  if (!server) {
    throw new Error(`MCP server not found: ${input.mcpServerId}`);
  }

  const serverName = server.serverTitle || server.name;
  const cases = await storage.listEnabledCasesForServerRun(input.mcpServerId);
  const run = await storage.createRun({
    mcpServerId: input.mcpServerId,
    totalCount: cases.length,
    triggeredBy: input.triggeredBy,
  });

  publishVerificationFrame(input.ownerId, {
    topic: "verification_run",
    kind: "run_started",
    runId: run.id,
    mcpServerId: input.mcpServerId,
    serverName,
    totalCount: cases.length,
  });

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
    return { runId: run.id, totalCount: 0 };
  }

  // 10 minutes global timeout for all server tools.
  void executeSuiteLoop({
    runId: run.id,
    ownerId: input.ownerId,
    timeoutSec: 600,
    targetName: serverName,
    category: "server",
    cases,
  });

  return { runId: run.id, totalCount: cases.length };
}

/**
 * Kick off a suite run. Returns synchronously with the new
 * {@link verification_run} id; the actual case loop runs in the
 * background and publishes SSE frames to `ownerId`'s channel.
 *
 * CONTRACT: the suite must exist and have at least one enabled case.
 * Empty / disabled suites short-circuit to a `passed` run with
 * totalCount=0 so the API caller still gets a clean record.
 */
export async function startSuiteRun(
  input: StartSuiteRunInput,
): Promise<StartSuiteRunResult> {
  const suite = await storage.getSuiteById(input.suiteId);
  if (!suite) throw new Error(`verification suite not found: ${input.suiteId}`);
  if (suite.category !== "mcp") {
    // V1 stops here. V2 will branch into a workflow runner.
    throw new Error("WORKFLOW_TESTS_V2");
  }

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
    return { runId: run.id, totalCount: 0 };
  }

  // Fire-and-forget background loop. We deliberately do NOT await —
  // the HTTP handler returns to the client immediately. The Node
  // event loop drives the loop to completion (or boot-epoch recovery
  // sweeps it on next restart).
  void executeSuiteLoop({
    runId: run.id,
    ownerId: input.ownerId,
    timeoutSec: suite.timeoutSec,
    targetName: suite.name,
    category: "suite",
    cases,
  });

  return { runId: run.id, totalCount: cases.length };
}

interface ExecuteSuiteLoopInput {
  runId: string;
  ownerId: string;
  timeoutSec: number;
  targetName: string;
  category: "suite" | "server";
  cases: Awaited<ReturnType<typeof storage.listEnabledCasesForRun>>;
}

/**
 * Mutable counters shared between the main loop and the crash
 * handler. Encapsulated as one object so the catch branch can read a
 * coherent snapshot without juggling 5 closure variables.
 */
interface LoopCounters {
  passedCount: number;
  failedCount: number;
  erroredCount: number;
  skippedCount: number;
  timedOut: boolean;
}

async function executeSuiteLoop(input: ExecuteSuiteLoopInput): Promise<void> {
  const counters: LoopCounters = {
    passedCount: 0,
    failedCount: 0,
    erroredCount: 0,
    skippedCount: 0,
    timedOut: false,
  };

  // Outer safety net. This whole function runs detached from the HTTP
  // handler (`void executeSuiteLoop(...)` in `startSuiteRun`), so any
  // uncaught throw becomes an Unhandled Promise Rejection that the
  // request lifecycle can never observe. If we don't trap it here,
  // `finalizeRun` never runs and `verification_run.status` is stuck
  // at `'running'` until the next boot-epoch recovery sweep. Persist
  // an `errored` terminal state and emit a `run_finished` frame so
  // the live UI unfreezes immediately. See docs/verification.md.
  try {
    await runSuiteCases(input, counters);
    await finaliseAndAnnounce(input, counters);
  } catch (err) {
    await handleSuiteLoopCrash(input, counters, err);
  }
}

/**
 * Inner serial loop — one tick per case. Mutates {@link counters} in
 * place. Throws on truly unexpected failures (e.g. provider-pool
 * blowing up), which the outer `executeSuiteLoop` catches.
 */
async function runSuiteCases(
  input: ExecuteSuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  const suiteStartedAt: number = Date.now();
  const timeoutMs: number = input.timeoutSec * 1000;

  for (const c of input.cases) {
    // Wall-clock check before each case — keeps the "remaining
    // cases get skipped" invariant precise without per-case
    // setTimeout bookkeeping.
    const elapsed: number = Date.now() - suiteStartedAt;
    if (elapsed > timeoutMs) {
      counters.timedOut = true;
      const skippedOutcome: CaseExecutionOutcome = {
        status: "skipped",
        resultPayload: null,
        resultTruncated: false,
        assertionResults: [],
        error: timeoutError("suite", elapsed),
        startedAt: Date.now(),
        durationMs: 0,
      };
      await persistAndPublish({
        ownerId: input.ownerId,
        runId: input.runId,
        caseId: c.id,
        outcome: skippedOutcome,
        inputSnapshot: c.input,
      });
      counters.skippedCount += 1;
      continue;
    }

    if (!c.mcpServerId || !c.toolName) {
      // V1 invariant: every enabled MCP case has both target fields
      // (CHECK constraint enforces this at the DB level too). Defend
      // in depth: if a row violates it, mark errored, don't crash.
      const outcome: CaseExecutionOutcome = {
        status: "errored",
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
        inputSnapshot: c.input,
      });
      counters.erroredCount += 1;
      continue;
    }

    // Per-case wall-clock cap. The suite-level check above only fires
    // BETWEEN cases — if `tool.execute` hangs forever inside a single
    // case the orchestrator would otherwise never reach that check and
    // the whole run would stay `running` until the next boot-epoch
    // sweep. Race the in-flight case against a setTimeout-resolved
    // sentinel outcome whose budget is `min(remainingSuiteBudget,
    // PER_CASE_MAX_MS)` so we never overshoot the suite cap either.
    const remainingSuiteMs = Math.max(0, timeoutMs - elapsed);
    const perCaseCapMs = Math.max(1, Math.min(remainingSuiteMs, PER_CASE_MAX_MS));
    const outcome: CaseExecutionOutcome = await runCaseWithCap({
      runId: input.runId,
      caseId: c.id,
      perCaseCapMs,
      runner: () =>
        runMcpCase({
          mcpServerId: c.mcpServerId!,
          toolName: c.toolName!,
          input: (c.input ?? {}) as Record<string, unknown>,
          assertions: (c.assertions ?? []) as readonly AssertionSpec[],
        }),
    });

    await persistAndPublish({
      ownerId: input.ownerId,
      runId: input.runId,
      caseId: c.id,
      outcome,
      inputSnapshot: c.input,
    });

    if (outcome.status === "passed") counters.passedCount += 1;
    else if (outcome.status === "failed") counters.failedCount += 1;
    else if (outcome.status === "errored") counters.erroredCount += 1;
    else if (outcome.status === "skipped") counters.skippedCount += 1;
  }
}

/**
 * Happy-path terminal step: derive the suite-level status from the
 * per-case tallies, persist it, and broadcast `run_finished` so live
 * subscribers can transition off the spinner.
 *
 * `finalizeRun` itself is wrapped in a best-effort try — a transient
 * DB failure should not also lose the SSE frame, since boot-epoch
 * recovery picks up unfinalised rows anyway.
 */
async function finaliseAndAnnounce(
  input: ExecuteSuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  const finalStatus: VerificationRunStatus = computeFinalStatus({
    timedOut: counters.timedOut,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
  });

  const isServer = input.category === "server";
  const title = isServer ? `Verification Server: ${input.targetName}` : `Verification: ${input.targetName}`;
  const sourceLabel = isServer ? "Verification Server" : "Verification Suite";
  const task = isServer ? `Run verification server '${input.targetName}'` : `Run verification suite '${input.targetName}'`;

  try {
    await storage.finalizeRun({
      runId: input.runId,
      status: finalStatus,
      passedCount: counters.passedCount,
      failedCount: counters.failedCount,
      erroredCount: counters.erroredCount,
      skippedCount: counters.skippedCount,
    });

    await recordRunNotification({
      ownerId: input.ownerId,
      runId: input.runId,
      kind: finalStatus === "passed" ? "run_completed" : "run_failed",
      title,
      body: `✓ ${counters.passedCount} Passed, ✗ ${counters.failedCount} Failed, ${counters.erroredCount} Errored, ${counters.skippedCount} Skipped`,
      sourceLabel,
      task,
      initiator: "verification",
    });
  } catch (err) {
    log.error(
      {
        event: "verification_finalize_failed",
        runId: input.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to finalise verification run; will be swept on next boot",
    );
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

/**
 * Crash recovery: an unexpected throw escaped the per-case guards.
 * Force an `errored` terminal state, best-effort persist + broadcast.
 * The `erroredCount + 1` accounts for the case whose throw landed us
 * here (no `case_finished` frame was emitted for it). If `finalizeRun`
 * itself fails (DB outage), boot-epoch recovery is the last resort.
 */
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

  const isServer = input.category === "server";
  const title = isServer ? `Verification Server: ${input.targetName}` : `Verification: ${input.targetName}`;
  const sourceLabel = isServer ? "Verification Server" : "Verification Suite";
  const task = isServer ? `Run verification server '${input.targetName}'` : `Run verification suite '${input.targetName}'`;

  try {
    await storage.finalizeRun({
      runId: input.runId,
      status: "errored",
      passedCount: counters.passedCount,
      failedCount: counters.failedCount,
      erroredCount: counters.erroredCount + 1,
      skippedCount: counters.skippedCount,
    });

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
  } catch {
    // swallow — boot-epoch sweeper is the last resort
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

/**
 * Race a case's runner against a wall-clock cap. The losing branch
 * (real or sentinel) is the one we persist; the OTHER branch — if the
 * race was decided by the timer — keeps running in the background but
 * is detached. We attach a `.catch` to suppress
 * `UnhandledPromiseRejection` warnings; the result is discarded.
 *
 * Returned status when the sentinel wins:
 *   - `errored` with `error.source = "timeout"`. We do NOT use the
 *     case-result `"timeout"` status here — that one is currently
 *     unwired in `computeFinalStatus` and would zero-out of the
 *     totals. `errored` correctly bubbles to the suite-level
 *     `"errored"` status (or stays under a suite-level `"timeout"`).
 */
async function runCaseWithCap(args: {
  runId: string;
  caseId: number;
  perCaseCapMs: number;
  runner: () => Promise<CaseExecutionOutcome>;
}): Promise<CaseExecutionOutcome> {
  const startedAt = Date.now();
  let timerHandle: ReturnType<typeof setTimeout> | null = null;

  const runnerPromise = args.runner();

  // Suppress unhandled rejection if the timer wins and the in-flight
  // promise later rejects — we no longer have a consumer for it.
  runnerPromise.catch((err) => {
    log.warn(
      {
        event: "verification_case_after_cap_rejected",
        runId: args.runId,
        caseId: args.caseId,
        err: err instanceof Error ? err.message : String(err),
      },
      "verification case promise rejected after per-case cap fired",
    );
  });

  const timeoutPromise = new Promise<CaseExecutionOutcome>((resolve) => {
    timerHandle = setTimeout(() => {
      log.warn(
        {
          event: "verification_case_cap_exceeded",
          runId: args.runId,
          caseId: args.caseId,
          perCaseCapMs: args.perCaseCapMs,
        },
        "verification case exceeded per-case wall-clock cap; abandoning",
      );
      resolve({
        status: "errored",
        resultPayload: null,
        resultTruncated: false,
        assertionResults: [],
        error: timeoutError("case", args.perCaseCapMs),
        startedAt,
        durationMs: args.perCaseCapMs,
      });
    }, args.perCaseCapMs);
  });

  try {
    return await Promise.race([runnerPromise, timeoutPromise]);
  } finally {
    if (timerHandle !== null) clearTimeout(timerHandle);
  }
}

/** Precedence: timeout > errored > failed > passed. See docs/verification.md. */
function computeFinalStatus(args: {
  timedOut: boolean;
  passedCount: number;
  failedCount: number;
  erroredCount: number;
}): VerificationRunStatus {
  if (args.timedOut) return "timeout";
  if (args.erroredCount > 0) return "errored";
  if (args.failedCount > 0) return "failed";
  return "passed";
}

interface PersistAndPublishInput {
  ownerId: string;
  runId: string;
  caseId: number;
  outcome: CaseExecutionOutcome;
  inputSnapshot: unknown;
}

async function persistAndPublish(input: PersistAndPublishInput): Promise<void> {
  try {
    await storage.writeCaseResult({
      runId: input.runId,
      caseId: input.caseId,
      outcome: input.outcome,
      inputSnapshot: input.inputSnapshot,
    });
  } catch (err) {
    // Persistence failure is ops-grade — log and continue so the
    // suite still emits its SSE frame. The user's UI will refresh
    // from the live state regardless.
    log.error(
      {
        event: "verification_case_persist_failed",
        runId: input.runId,
        caseId: input.caseId,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to persist verification_case_result",
    );
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
