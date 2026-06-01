/**
 * Verification — boot-epoch zombie sweep for `verification_run`.
 *
 * Mirrors the `runner/recovery.ts → recoverStrandedRuns` pattern.
 * Any row in `status='running'` with `started_at < bootStartedAt` is
 * by definition a leftover from a previous Node process — flip it
 * to `errored` so the UI shows a stable terminal state.
 *
 * V1 does NOT publish SSE frames or write notifications during
 * recovery — the user's previous EventSource is already disconnected
 * by the restart; their next page refresh reads the persisted state.
 *
 * See docs/verification.md ("Crash recovery") and
 * docs/orchestrator.md for the parent design.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";

import {
  listEnabledCasesForRun,
  listWrittenCaseIdsForRun,
  markStrandedAsErrored,
  selectStrandedRuns,
  writeSkippedCaseResults,
} from "./storage";

const log = childLogger({ component: "verification-recovery" });

/**
 * CONTRACT: idempotent — re-running on a clean DB is a no-op. Called
 * from `instrumentation.ts` after `recoverStrandedRuns` but before
 * the scheduler bootstrap.
 *
 * Two-phase sweep:
 *
 *   1. For each stranded run, back-fill `verification_case_result`
 *      rows for cases that the orchestrator never reached (status
 *      `skipped`, error `source: "crashed"`). This keeps the UI
 *      invariant `count(case_result) == verification_run.totalCount`
 *      stable so the history view doesn't render half-empty rows.
 *
 *   2. Flip the run rows themselves to `errored` in one UPDATE.
 *
 * The phases are NOT wrapped in a single transaction — if recovery
 * itself crashes between (1) and (2) the next boot retries both:
 * step 1 is idempotent via the `(run_id, case_id)` UNIQUE index +
 * `onConflictDoNothing()`, step 2 is idempotent because
 * `markStrandedAsErrored` only touches rows still in `running`.
 */
export async function recoverStrandedVerificationRuns(
  currentBootStartedAt: Date,
): Promise<void> {
  const stale = await selectStrandedRuns(currentBootStartedAt);

  if (stale.length === 0) {
    log.debug(
      {
        event: "verification_recovery_clean",
        bootStartedAt: currentBootStartedAt.toISOString(),
      },
      "no stranded verification runs found",
    );
    return;
  }

  // Phase 1: back-fill missing case_result rows so totalCount matches
  // count(case_result) once the run is flipped to `errored`.
  let totalFilled = 0;
  for (const run of stale) {
    const writtenIds = await listWrittenCaseIdsForRun(run.id);
    const missingCount = run.totalCount - writtenIds.length;
    if (missingCount <= 0) continue;

    // Take the suite's currently enabled cases in the SAME
    // alphabetical order the orchestrator iterates, drop already-
    // written ones, and fill the first `missingCount`. Approximation
    // assumes the enabled-case set didn't drift between run start and
    // crash; in practice both events happen on the same boot. If
    // cases were added since, the trailing ones get dropped by
    // `.slice` and never enter the filler set (no false positives).
    // If unwritten cases were DELETED, candidates shrinks → we fill
    // best-effort and the resulting count(case_result) < totalCount
    // — UI must tolerate this drift.
    const candidates = await listEnabledCasesForRun(run.suiteId);
    const writtenSet = new Set(writtenIds);
    const missingIds = candidates
      .filter((c) => !writtenSet.has(c.id))
      .slice(0, missingCount)
      .map((c) => c.id);

    if (missingIds.length > 0) {
      await writeSkippedCaseResults(run.id, missingIds);
      totalFilled += missingIds.length;
      log.info(
        {
          event: "verification_recovery_filled",
          runId: run.id,
          missingCount,
          filled: missingIds.length,
        },
        "filled missing case_result rows for stranded run",
      );
    }
  }

  // Phase 2: flip the run headers.
  await markStrandedAsErrored(currentBootStartedAt);

  log.info(
    {
      event: "verification_recovery_completed",
      count: stale.length,
      filled: totalFilled,
      bootStartedAt: currentBootStartedAt.toISOString(),
    },
    "marked stranded verification runs as errored",
  );
}
