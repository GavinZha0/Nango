/**
 * Single source of truth for applying a partial update to a schedule row.
 *
 * See docs/orchestrator.md.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  ScheduleTable,
  type ScheduleEntity,
  type ScheduleIntervalUnit,
} from "@/lib/db/schema";
import {
  registerSchedule,
  unregisterSchedule,
  validateTriggerSpec,
} from "@/lib/runner/scheduler";

export interface SchedulePatch {
  task?: string;
  startAt?: Date;
  endAt?: Date | null;
  intervalValue?: number | null;
  intervalUnit?: ScheduleIntervalUnit | null;
  timezone?: string;
  name?: string | null;
  enabled?: boolean;
}

export interface ApplyScheduleUpdateOptions {
  /** Reject `startAt` patches in the past. The LLM-facing
   *  `update_schedule` tool sets this; REST PATCH leaves it off so
   *  power users can backfill for testing / audit. */
  requireFutureStartAt?: boolean;
}

export type ApplyScheduleUpdateResult =
  | { ok: true; row: ScheduleEntity }
  | { ok: false; code: "NOT_FOUND" | "BAD_REQUEST"; error: string };

export async function applyScheduleUpdate(
  ownerId: string,
  scheduleId: string,
  patch: SchedulePatch,
  options: ApplyScheduleUpdateOptions = {},
): Promise<ApplyScheduleUpdateResult> {
  const [existing] = await db
    .select()
    .from(ScheduleTable)
    .where(
      and(
        eq(ScheduleTable.id, scheduleId),
        eq(ScheduleTable.ownerId, ownerId),
      ),
    )
    .limit(1);
  if (!existing) {
    return { ok: false, code: "NOT_FOUND", error: "Schedule not found." };
  }

  if (
    options.requireFutureStartAt
    && patch.startAt !== undefined
    && patch.startAt.getTime() <= Date.now()
  ) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      error: "startAt must be in the future.",
    };
  }

  const touchedSpec =
    patch.startAt !== undefined
    || patch.endAt !== undefined
    || patch.intervalValue !== undefined
    || patch.intervalUnit !== undefined;

  const nextStartAt = patch.startAt ?? existing.startAt;
  const nextEndAt =
    patch.endAt !== undefined ? patch.endAt : existing.endAt;
  const nextIntervalValue =
    patch.intervalValue !== undefined
      ? patch.intervalValue
      : existing.intervalValue;
  const nextIntervalUnit =
    patch.intervalUnit !== undefined
      ? patch.intervalUnit
      : (existing.intervalUnit as ScheduleIntervalUnit | null);

  const nextTimezone = patch.timezone ?? existing.timezone;
  if (touchedSpec || patch.timezone !== undefined) {
    const validation = validateTriggerSpec({
      startAt: nextStartAt,
      endAt: nextEndAt,
      intervalValue: nextIntervalValue,
      intervalUnit: nextIntervalUnit,
      timezone: nextTimezone,
    });
    if (!validation.ok) {
      return { ok: false, code: "BAD_REQUEST", error: validation.error };
    }
  }

  const [updated] = await db
    .update(ScheduleTable)
    .set({
      ...(patch.task !== undefined ? { task: patch.task } : {}),
      ...(patch.startAt !== undefined ? { startAt: nextStartAt } : {}),
      ...(patch.endAt !== undefined ? { endAt: nextEndAt } : {}),
      ...(patch.intervalValue !== undefined
        ? { intervalValue: nextIntervalValue }
        : {}),
      ...(patch.intervalUnit !== undefined
        ? { intervalUnit: nextIntervalUnit }
        : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(touchedSpec
        ? { lastTriggeredAt: null, lastError: null }
        : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(ScheduleTable.id, scheduleId))
    .returning();

  if (updated.enabled) {
    registerSchedule(updated);
  } else {
    unregisterSchedule(updated.id);
  }

  return { ok: true, row: updated };
}
