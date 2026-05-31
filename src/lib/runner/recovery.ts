/**
 * Boot-time sweep for runs left in `running` after a crash / redeploy.
 *
 * See docs/orchestrator.md.
 */

import "server-only";

import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { EntityRunTable } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";
import { recordRunNotification } from "./notifications";

const log = childLogger({ component: "runner-recovery" });

interface StaleRow {
  id: string;
  ownerId: string;
  entityId: string;
  inputTask: string;
}

/**
 * Sweep zombie `entity_run` rows from any prior Node process.
 *
 * @param currentBootStartedAt timestamp of the boot row inserted by
 *   {@link recordProcessBoot}. Rows with `started_at < currentBootStartedAt`
 *   are flipped to `failed` + notified.
 *
 * CONTRACT: idempotent — re-running on a clean DB is a no-op.
 */
export async function recoverStrandedRuns(
  currentBootStartedAt: Date,
): Promise<void> {
  const stale: StaleRow[] = await db
    .select({
      id: EntityRunTable.id,
      ownerId: EntityRunTable.ownerId,
      entityId: EntityRunTable.entityId,
      inputTask: EntityRunTable.inputTask,
    })
    .from(EntityRunTable)
    .where(
      and(
        eq(EntityRunTable.status, "running"),
        lt(EntityRunTable.startedAt, currentBootStartedAt),
      ),
    );

  if (stale.length === 0) {
    log.debug(
      { event: "recovery_clean", bootStartedAt: currentBootStartedAt.toISOString() },
      "no stranded runs found",
    );
    return;
  }

  const errorMessage = "Run interrupted by server restart.";
  await db
    .update(EntityRunTable)
    .set({
      status: "failed",
      errorMessage,
      finishedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(EntityRunTable.status, "running"),
        lt(EntityRunTable.startedAt, currentBootStartedAt),
      ),
    );

  for (const row of stale) {
    await recordRunNotification({
      ownerId: row.ownerId,
      runId: row.id,
      kind: "run_failed",
      title: "A task was interrupted",
      body: errorMessage,
      task: row.inputTask,
    });
  }

  log.info(
    {
      event: "recovery_completed",
      count: stale.length,
      bootStartedAt: currentBootStartedAt.toISOString(),
    },
    "marked stranded runs as failed",
  );
}
