import "server-only";

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { ScheduleTable } from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import { triggerSchedule } from "@/lib/runner/scheduler";

/**
 * POST /api/schedules/[id]/trigger — fire a schedule immediately.
 */

const ROUTE = "/api/schedules/[id]/trigger";

export const POST = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    // Cheap pre-check: confirm ownership before the trigger helper
    // hits the runner. The helper itself ignores rows that no longer
    // exist, but doing the auth check here means we return a clean
    // 404 instead of a silent no-op.
    const [row] = await db
      .select({ id: ScheduleTable.id, enabled: ScheduleTable.enabled })
      .from(ScheduleTable)
      .where(
        and(
          eq(ScheduleTable.id, params.id),
          eq(ScheduleTable.ownerId, session.user.id),
        ),
      )
      .limit(1);
    if (!row) {
      throw new ApiError("NOT_FOUND", 404, "Schedule not found.");
    }
    if (!row.enabled) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Schedule is disabled. Enable it before triggering.",
      );
    }
    await triggerSchedule(params.id);
    return NextResponse.json({ ok: true });
  },
);
