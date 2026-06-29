/**
 * Evaluation — boot-epoch recovery for stranded `eval_run` rows.
 *
 * Any row in `status='running'` with `started_at < bootStartedAt` is
 * a leftover from a previous Node process — flip to `errored`.
 * Mirrors `verification/recovery.ts`.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";

import { selectStrandedRuns, markStrandedAsErrored } from "./storage";

const log = childLogger({ component: "eval-recovery" });

/** CONTRACT: idempotent — safe to call on a clean DB. */
export async function recoverStrandedEvalRuns(
  currentBootStartedAt: Date,
): Promise<void> {
  const stale = await selectStrandedRuns(currentBootStartedAt);

  if (stale.length === 0) {
    log.debug(
      { event: "eval_recovery_clean", bootStartedAt: currentBootStartedAt.toISOString() },
      "no stranded eval runs found",
    );
    return;
  }

  const count = await markStrandedAsErrored(currentBootStartedAt);

  log.info(
    { event: "eval_recovery_completed", count, bootStartedAt: currentBootStartedAt.toISOString() },
    `marked ${count} stranded eval run(s) as errored`,
  );
}
