/**
 * Wire shape + projection for `schedule` rows.
 */

import "server-only";

import type { ScheduleEntity, ScheduleIntervalUnit } from "@/lib/db/schema";
import { nextFireAt } from "@/lib/runner/scheduler";

export interface ScheduleResponse {
  id: string;
  name: string | null;
  entityId: string;
  credentialId: string | null;
  sourceLabel: string;
  task: string;
  /** Required first-fire instant (ISO). */
  startAt: string;
  /** Optional cap; null = no end. */
  endAt: string | null;
  /** Pair: both null (one-shot) OR both set. */
  intervalValue: number | null;
  intervalUnit: ScheduleIntervalUnit | null;
  timezone: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastError: string | null;
  /** Computed by the scheduler from start/interval/end + lastTriggeredAt;
   *  null when the row is disabled or has run out of fires. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toScheduleResponse(row: ScheduleEntity): ScheduleResponse {
  return {
    id: row.id,
    name: row.name,
    entityId: row.entityId,
    credentialId: row.credentialId,
    sourceLabel: row.sourceLabel,
    task: row.task,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt ? row.endAt.toISOString() : null,
    intervalValue: row.intervalValue,
    intervalUnit: row.intervalUnit as ScheduleIntervalUnit | null,
    timezone: row.timezone,
    enabled: row.enabled,
    lastTriggeredAt: row.lastTriggeredAt
      ? row.lastTriggeredAt.toISOString()
      : null,
    lastError: row.lastError,
    nextRunAt: row.enabled
      ? nextFireAt(row)?.toISOString() ?? null
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
