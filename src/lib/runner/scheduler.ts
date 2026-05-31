/**
 * In-process scheduler for `schedule` rows. One `setTimeout` per
 * active schedule.
 *
 * See docs/orchestrator.md.
 */

import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  ScheduleTable,
  type ScheduleEntity,
  type ScheduleIntervalUnit,
} from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";
import { runner } from "@/lib/runner";
import type { EntityKind } from "@/lib/backends/types";

const log = childLogger({ component: "scheduler" });

const VALID_UNITS: readonly ScheduleIntervalUnit[] = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
];

/** IANA timezone set from bundled ICU data. */
const IANA_TIMEZONES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf("timeZone"),
);

/** Validate that `tz` is a recognised IANA timezone identifier.
 *  "UTC" is always accepted (not in every ICU build's list). */
export function isValidTimezone(tz: string): boolean {
  return tz === "UTC" || IANA_TIMEZONES.has(tz);
}

/** Validate a trigger spec without persisting. Used by the API +
 *  supervisor tool to fail loudly before a write. */
export function validateTriggerSpec(spec: {
  startAt: Date;
  endAt: Date | null;
  intervalValue: number | null;
  intervalUnit: ScheduleIntervalUnit | null;
  timezone?: string;
}): { ok: true } | { ok: false; error: string } {
  if (spec.timezone && !isValidTimezone(spec.timezone)) {
    return { ok: false, error: `Invalid IANA timezone: '${spec.timezone}'.` };
  }
  if (Number.isNaN(spec.startAt.getTime())) {
    return { ok: false, error: "startAt is invalid." };
  }
  // CONTRACT: intervalValue + intervalUnit go together (both or neither).
  const haveValue = spec.intervalValue !== null;
  const haveUnit = spec.intervalUnit !== null;
  if (haveValue !== haveUnit) {
    return {
      ok: false,
      error: "intervalValue and intervalUnit must be set together.",
    };
  }
  if (haveValue) {
    if (!Number.isFinite(spec.intervalValue!) || spec.intervalValue! <= 0) {
      return { ok: false, error: "intervalValue must be a positive integer." };
    }
    if (!VALID_UNITS.includes(spec.intervalUnit!)) {
      return {
        ok: false,
        error: `intervalUnit must be one of: ${VALID_UNITS.join(", ")}.`,
      };
    }
  } else {
    // One-shot startAt must be in the future. Recurring startAt acts
    // as an anchor and may be in the past. 5s slack for clock skew.
    if (spec.startAt.getTime() < Date.now() - 5_000) {
      return {
        ok: false,
        error: "One-shot startAt must be in the future.",
      };
    }
  }
  if (spec.endAt) {
    if (Number.isNaN(spec.endAt.getTime())) {
      return { ok: false, error: "endAt is invalid." };
    }
    if (spec.endAt.getTime() <= spec.startAt.getTime()) {
      return { ok: false, error: "endAt must be after startAt." };
    }
    if (!haveValue) {
      return { ok: false, error: "endAt requires an interval." };
    }
  }
  return { ok: true };
}

/**
 * Add interval to a Date. Day/week/month walk the calendar in the
 * schedule's timezone (DST-safe). Minute/hour add fixed milliseconds.
 */
export function addInterval(
  base: Date,
  value: number,
  unit: ScheduleIntervalUnit,
  timezone: string,
): Date {
  if (unit === "minute") return new Date(base.getTime() + value * 60_000);
  if (unit === "hour") return new Date(base.getTime() + value * 3_600_000);

  const parts = getDateTimeParts(base, timezone);
  const target = { ...parts };
  if (unit === "day") target.day += value;
  else if (unit === "week") target.day += value * 7;
  else if (unit === "month") target.month += value;
  return composeDate(target, timezone);
}

interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** UTC instant → wall-clock parts in the named tz. */
function getDateTimeParts(d: Date, tz: string): DateParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // Intl returns "24" at midnight on some platforms
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Re-assemble wall-clock parts → UTC instant. Walks offset twice to
 * converge through DST transitions.
 */
function composeDate(p: DateParts, tz: string): Date {
  const utcGuess = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  const offset1 = tzOffsetMs(new Date(utcGuess), tz);
  const tryA = new Date(utcGuess - offset1);
  const offset2 = tzOffsetMs(tryA, tz);
  return new Date(utcGuess - offset2);
}

function tzOffsetMs(d: Date, tz: string): number {
  const local = getDateTimeParts(d, tz);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asUtc - d.getTime();
}

/**
 * Compute next fire time, or `null` when the schedule has run out.
 *
 * CONTRACT:
 *   - One-shot (no interval): startAt if not yet fired, else null.
 *   - Recurring: walk `startAt + k × interval` until strictly after
 *     `lastTriggeredAt ?? -∞` AND `now`. Returns null past endAt.
 *
 * The `now` guard prevents backfilling on rows created in the past.
 */
export function nextFireAt(row: ScheduleEntity, now: Date = new Date()): Date | null {
  const { startAt, endAt, intervalValue, intervalUnit, timezone, lastTriggeredAt } =
    row;

  if (intervalValue === null || intervalUnit === null) {
    if (lastTriggeredAt) return null;
    return startAt;
  }

  const unit = intervalUnit as ScheduleIntervalUnit;
  const value = intervalValue;

  const lowerMs = Math.max(
    now.getTime(),
    lastTriggeredAt ? lastTriggeredAt.getTime() + 1 : -Infinity,
  );

  // Bound the walk so a misconfigured schedule can't spin forever.
  let candidate = startAt;
  let steps = 0;
  const MAX_STEPS = 100_000;
  while (candidate.getTime() < lowerMs) {
    candidate = addInterval(candidate, value, unit, timezone);
    if (++steps >= MAX_STEPS) {
      log.warn(
        {
          event: "next_fire_overflow",
          scheduleId: row.id,
          steps: MAX_STEPS,
          interval: `${value} ${unit}`,
          lastTriggeredAt: lastTriggeredAt?.toISOString() ?? null,
        },
        "schedule next-fire calculation exceeded max iterations; auto-disabling",
      );
      return null;
    }
  }
  if (endAt && candidate.getTime() > endAt.getTime()) return null;
  return candidate;
}

interface JobHandle {
  schedule: ScheduleEntity;
  timer: ReturnType<typeof setTimeout>;
}

interface SchedulerSlot {
  jobs: Map<string, JobHandle>;
  bootstrapped: boolean;
}

const GLOBAL_KEY = Symbol.for("nango.runner.scheduler");
type Holder = { [k: symbol]: SchedulerSlot | undefined };
const holder = globalThis as Holder;

function slot(): SchedulerSlot {
  let s = holder[GLOBAL_KEY];
  if (!s) {
    s = { jobs: new Map(), bootstrapped: false };
    holder[GLOBAL_KEY] = s;
  }
  return s;
}

/** Node clamps `setTimeout` to int32; re-arm in chunks past 24d. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Trigger a schedule once (timer tick OR manual "Trigger now").
 * Updates `lastTriggeredAt` / `lastError`, then re-registers so the
 * next timer reflects new state (also handles end-of-window
 * auto-disable). Per-schedule run history lives on
 * `entity_run.schedule_id`.
 */
export async function triggerSchedule(scheduleId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(ScheduleTable)
    .where(eq(ScheduleTable.id, scheduleId))
    .limit(1);

  if (!row) {
    log.warn(
      { event: "trigger_missing", scheduleId },
      "schedule no longer exists; ignoring trigger",
    );
    return;
  }
  if (!row.enabled) {
    log.info(
      { event: "trigger_skipped_disabled", scheduleId },
      "schedule is disabled; skipping trigger",
    );
    return;
  }

  let updated: ScheduleEntity | undefined;
  let runResult: Awaited<ReturnType<typeof runner.start>> | undefined;
  try {
    runResult = await runner.start({
      entityId: row.entityId,
      credentialId: row.credentialId ?? undefined,
      // Kind snapshotted at create time — no entity-catalog round-trip on fire.
      entityKind: row.entityKind as EntityKind,
      task: row.task,
      mode: "async",
      initiator: "schedule",
      scheduleId: row.id,
      ownerId: row.ownerId,
      createdBy: row.createdBy,
      sourceLabel: row.sourceLabel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      [updated] = await db
        .update(ScheduleTable)
        .set({
          lastTriggeredAt: sql`CURRENT_TIMESTAMP`,
          lastError: message,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(ScheduleTable.id, scheduleId))
        .returning();
    } catch { /* best-effort bookkeeping */ }
    log.warn(
      { event: "trigger_failed", scheduleId, err: message },
      "schedule fire failed",
    );
  }

  // Split from runner.start() so a DB failure here never overwrites
  // a successful run with lastError. Only refreshes summary fields;
  // full history reads from entity_run via schedule_id.
  if (runResult) {
    try {
      [updated] = await db
        .update(ScheduleTable)
        .set({
          lastTriggeredAt: sql`CURRENT_TIMESTAMP`,
          lastError: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(ScheduleTable.id, scheduleId))
        .returning();
    } catch (dbErr) {
      log.error(
        { event: "trigger_bookkeeping_failed", scheduleId, runId: runResult.runId, err: dbErr instanceof Error ? dbErr.message : String(dbErr) },
        "schedule bookkeeping update failed after successful run",
      );
    }
    log.info(
      { event: "trigger_dispatched", scheduleId, runId: runResult.runId },
      "schedule fired",
    );
  }

  // If bookkeeping failed, synthesise a snapshot so re-arm still
  // works; next boot replays from DB state anyway.
  if (!updated && runResult) {
    updated = { ...row, lastTriggeredAt: new Date(), lastError: null };
  }

  if (updated) {
    // Auto-disable one-shots — keep the row as a completed record
    // but evict from the timer map.
    if (updated.intervalValue === null) {
      await db
        .update(ScheduleTable)
        .set({ enabled: false, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(ScheduleTable.id, scheduleId));
      unregisterSchedule(scheduleId);
      return;
    }
    // Recurring — rearm; registerSchedule auto-disables past endAt.
    registerSchedule(updated);
  }
}

/** Idempotent: stop and forget the timer for `scheduleId` if any.
 *  DB row left untouched. */
export function unregisterSchedule(scheduleId: string): void {
  const s = slot();
  const handle = s.jobs.get(scheduleId);
  if (!handle) return;
  clearTimeout(handle.timer);
  s.jobs.delete(scheduleId);
}

/**
 * Register / re-register a schedule. Disabled rows or rows whose next
 * fire would fall past `endAt` are auto-disabled and unregistered.
 */
export function registerSchedule(row: ScheduleEntity): void {
  const s = slot();
  unregisterSchedule(row.id);
  if (!row.enabled) return;

  const next = nextFireAt(row);
  if (!next) {
    // Exhausted — disable so the panel reflects state.
    void db
      .update(ScheduleTable)
      .set({ enabled: false, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(ScheduleTable.id, row.id))
      .catch(() => undefined);
    return;
  }

  const armWith = (delayMs: number): ReturnType<typeof setTimeout> => {
    if (delayMs > MAX_TIMER_MS) {
      return setTimeout(
        () => registerSchedule(row),
        MAX_TIMER_MS,
      );
    }
    return setTimeout(() => {
      void triggerSchedule(row.id);
    }, Math.max(0, delayMs));
  };

  const timer = armWith(next.getTime() - Date.now());
  s.jobs.set(row.id, { schedule: row, timer });
}

/** CONTRACT: idempotent — guarded by `bootstrapped` flag so HMR /
 *  re-imports don't double-register. */
export async function bootstrapScheduler(): Promise<void> {
  const s = slot();
  if (s.bootstrapped) return;
  s.bootstrapped = true;

  const rows = await db
    .select()
    .from(ScheduleTable)
    .where(eq(ScheduleTable.enabled, true));
  for (const row of rows) registerSchedule(row);
  log.info(
    { event: "scheduler_bootstrapped", count: rows.length },
    "scheduler ready",
  );
}

/** Clear all armed timers and reset the scheduler state. Called on
 *  process shutdown (SIGTERM / SIGINT) to enable graceful exit. */
export function shutdownScheduler(): void {
  const s = slot();
  for (const handle of s.jobs.values()) {
    clearTimeout(handle.timer);
  }
  const count = s.jobs.size;
  s.jobs.clear();
  s.bootstrapped = false;
  log.info({ event: "scheduler_shutdown", cleared: count }, "all timers cleared");
}

/** For tests / introspection. */
export function listRegisteredScheduleIds(): string[] {
  return Array.from(slot().jobs.keys());
}
