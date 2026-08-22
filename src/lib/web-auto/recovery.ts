/**
 * Web Auto — boot-epoch zombie sweep for `web_auto_run`.
 *
 * Mirrors `verification/recovery.ts` and `evaluation/recovery.ts`.
 * Any row in `status='running'` with `started_at < bootStartedAt` is
 * by definition a leftover from a previous Node process — flip it
 * to `errored` so the UI shows a stable terminal state.
 *
 * See docs/web-auto.md and docs/orchestrator.md.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";

import {
  listEnabledWebAutoCasesForRun,
  listWrittenCaseIdsForWebAutoRun,
  markStrandedWebAutoRunsAsErrored,
  selectStrandedWebAutoRuns,
  writeErroredCaseResults,
} from "./storage";

const log = childLogger({ component: "web-auto-recovery" });

/**
 * CONTRACT: idempotent — re-running on a clean DB is a no-op. Called
 * from `instrumentation.ts` alongside verification and evaluation recovery.
 *
 * Two-phase sweep:
 *
 *   1. For each stranded run, back-fill `web_auto_case_result`
 *      rows for cases that the orchestrator never reached (status
 *      `errored`, error `source: "crashed"`). This ensures the UI
 *      shows all scheduled cases with an explanation of why they didn't run.
 *
 *   2. Flip the run headers themselves to `errored` in one UPDATE.
 */
export async function recoverStrandedWebAutoRuns(
  currentBootStartedAt: Date,
): Promise<void> {
  const stale = await selectStrandedWebAutoRuns(currentBootStartedAt);
  if (stale.length === 0) {
    log.info(
      {
        event: "web_auto_recovery_clean",
        bootStartedAt: currentBootStartedAt.toISOString(),
      },
      "no stranded web-auto runs found",
    );
    return;
  }

  // Phase 1: back-fill missing case_result rows for stranded runs
  let totalFilled = 0;
  for (const run of stale) {
    const writtenIds = await listWrittenCaseIdsForWebAutoRun(run.id);
    const candidates = await listEnabledWebAutoCasesForRun(run.suiteId);
    const writtenSet = new Set(writtenIds);
    const missingIds = candidates
      .filter((c) => !writtenSet.has(c.id))
      .map((c) => c.id);

    if (missingIds.length > 0) {
      await writeErroredCaseResults(run.id, missingIds);
      totalFilled += missingIds.length;
      log.info(
        {
          event: "web_auto_recovery_filled",
          runId: run.id,
          filled: missingIds.length,
        },
        "filled missing case_result rows for stranded web-auto run",
      );
    }
  }

  // Phase 2: flip the run headers.
  await markStrandedWebAutoRunsAsErrored(currentBootStartedAt);

  log.info(
    {
      event: "web_auto_recovery_completed",
      count: stale.length,
      filled: totalFilled,
      bootStartedAt: currentBootStartedAt.toISOString(),
    },
    "marked stranded web-auto runs as errored",
  );
}
