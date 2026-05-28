import "server-only";

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  EntityRunTable,
  NotificationTable,
  ScheduleTable,
} from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import type {
  ScheduleRunSummary,
  ScheduleRunsResponse,
} from "@/lib/runner/schedule-runs-dto";

/**
 * GET /api/schedules/[id]/runs — paginated execution history for one
 * schedule, newest first.
 *
 * Backs the `RecentRuns` side panel inside ScheduleEditor. Each row
 * carries just enough to render a single-line summary: time, status,
 * and a single line of text (output summary on success, error message
 * on failure). The full run row / event stream stays in
 * `entity_run` / `entity_run_event` and is only reachable from the
 * admin `/admin/run/[id]` view (see AGENTS.md §15).
 *
 * Owner isolation: we look up the schedule first and bail with 404 if
 * it doesn't belong to the caller, so a probing request can't
 * fingerprint another user's schedule ids by timing.
 */
const ROUTE = "/api/schedules/[id]/runs";

/** Hard cap so a misbehaving client can't ask for the whole table. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    // 1. Owner check — short DB hop, prevents probing other users.
    const [schedule] = await db
      .select({ id: ScheduleTable.id })
      .from(ScheduleTable)
      .where(
        and(
          eq(ScheduleTable.id, params.id),
          eq(ScheduleTable.ownerId, session.user.id),
        ),
      )
      .limit(1);
    if (!schedule) {
      throw new ApiError("NOT_FOUND", 404, "Schedule not found.");
    }

    // 2. Clamp the requested limit. We don't expose cursor pagination
    //    yet — the panel only shows the top N and the per-schedule
    //    cardinality is tiny.
    const requested = Number(new URL(req.url).searchParams.get("limit"));
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(MAX_LIMIT, Math.floor(requested))
        : DEFAULT_LIMIT;

    // 3. History query — owner-scoped AND schedule_id-scoped. The
    //    `(schedule_id, created_at DESC)` index satisfies both
    //    predicates and the ORDER BY without a sort step.
    //
    //    LEFT JOIN `notification` on run_id because async/scheduled
    //    runs' finalised text lands there (`fullBody` / `body`), not
    //    on `entity_run.outputSummary`. The runner's PersistingAgent
    //    writes only the status to entity_run on completion; the
    //    accumulated answer text is forwarded to
    //    `recordRunNotification` instead. Joining here keeps the
    //    history list self-contained without changing the runner's
    //    write path (which has its own invariants around terminal
    //    UPDATE idempotency).
    const rows = await db
      .select({
        id: EntityRunTable.id,
        status: EntityRunTable.status,
        createdAt: EntityRunTable.createdAt,
        finishedAt: EntityRunTable.finishedAt,
        outputSummary: EntityRunTable.outputSummary,
        errorMessage: EntityRunTable.errorMessage,
        notificationFullBody: NotificationTable.fullBody,
        notificationBody: NotificationTable.body,
      })
      .from(EntityRunTable)
      .leftJoin(
        NotificationTable,
        eq(NotificationTable.runId, EntityRunTable.id),
      )
      .where(
        and(
          eq(EntityRunTable.scheduleId, params.id),
          eq(EntityRunTable.ownerId, session.user.id),
        ),
      )
      .orderBy(desc(EntityRunTable.createdAt))
      .limit(limit);

    const items: ScheduleRunSummary[] = rows.map((r) => {
      // Coalesce in priority order:
      //  - failed run → operator wants the error string first
      //  - succeeded → prefer the notification's full body (the
      //    actual agent answer), fall back to the truncated preview,
      //    then to outputSummary as a last resort
      const notificationText = r.notificationFullBody ?? r.notificationBody;
      const summaryLine =
        r.status === "failed"
          ? r.errorMessage ?? notificationText ?? r.outputSummary ?? null
          : notificationText ?? r.outputSummary ?? r.errorMessage ?? null;
      return {
        runId: r.id,
        status: r.status,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        summaryLine,
      };
    });

    const body: ScheduleRunsResponse = { items };
    return NextResponse.json(body);
  },
);
