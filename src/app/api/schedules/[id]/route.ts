import "server-only";

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { ScheduleTable } from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { unregisterSchedule } from "@/lib/runner/scheduler";
import { toScheduleResponse } from "@/lib/runner/schedule-dto";
import { applyScheduleUpdate } from "@/lib/runner/schedule-mutate";

/**
 * Per-schedule mutations:
 */

const ROUTE = "/api/schedules/[id]";

const intervalUnitSchema = z.enum([
  "minute",
  "hour",
  "day",
  "week",
  "month",
]);

const patchBodySchema = z.object({
  task: z.string().min(1).optional(),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().nullable().optional(),
  intervalValue: z.number().int().positive().nullable().optional(),
  intervalUnit: intervalUnitSchema.nullable().optional(),
  timezone: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export const PATCH = withSession<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, patchBodySchema);

    const result = await applyScheduleUpdate(session.user.id, params.id, {
      ...(body.task !== undefined ? { task: body.task } : {}),
      ...(body.startAt !== undefined
        ? { startAt: new Date(body.startAt) }
        : {}),
      ...(body.endAt !== undefined
        ? { endAt: body.endAt === null ? null : new Date(body.endAt) }
        : {}),
      ...(body.intervalValue !== undefined
        ? { intervalValue: body.intervalValue }
        : {}),
      ...(body.intervalUnit !== undefined
        ? { intervalUnit: body.intervalUnit }
        : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.name !== undefined ? { name: body.name?.trim() || null } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });

    if (!result.ok) {
      throw new ApiError(
        result.code,
        result.code === "NOT_FOUND" ? 404 : 400,
        result.error,
      );
    }

    return NextResponse.json(toScheduleResponse(result.row));
  },
);

export const DELETE = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const removed = await db
      .delete(ScheduleTable)
      .where(
        and(
          eq(ScheduleTable.id, params.id),
          eq(ScheduleTable.ownerId, session.user.id),
        ),
      )
      .returning({ id: ScheduleTable.id });
    if (removed.length === 0) {
      throw new ApiError("NOT_FOUND", 404, "Schedule not found.");
    }
    unregisterSchedule(params.id);
    return new NextResponse(null, { status: 204 });
  },
);
