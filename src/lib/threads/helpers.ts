/**
 * Shared client/server helpers for chat thread titles and history grouping.
 */

import type { SessionDescriptor } from "@/lib/backends/types";

export const MAX_THREAD_TITLE_CHARS = 120;

export type HistoryTimeGroup =
  | "pinned"
  | "today"
  | "yesterday"
  | "last7days"
  | "last30days";

export const HISTORY_TIME_GROUPS: readonly HistoryTimeGroup[] = [
  "pinned",
  "today",
  "yesterday",
  "last7days",
  "last30days",
] as const;

export const HISTORY_GROUP_LABELS: Record<HistoryTimeGroup, string> = {
  pinned: "Pinned",
  today: "Today",
  yesterday: "Yesterday",
  last7days: "Last 7 days",
  last30days: "Last 30 days",
};

/**
 * Clip the first user prompt to a one-line thread title on a word boundary.
 * The full prompt remains in `entity_run.input_task`.
 */
export function pickThreadTitle(raw: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.length <= 80) return trimmed;
  const cut = trimmed.slice(0, 80);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 40 ? `${cut.slice(0, lastSpace)}…` : `${cut}…`;
}

/**
 * Resolve the display title for a thread: custom title wins over the
 * prompt-derived title, falling back to a generic placeholder.
 */
export function resolveThreadDisplayTitle(
  customTitle: string | null | undefined,
  firstInputTask: string | null | undefined,
): string {
  const custom = customTitle?.trim();
  if (custom) return custom;
  return pickThreadTitle(firstInputTask ?? null) || "Untitled conversation";
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(dayStart: Date, deltaDays: number): Date {
  return new Date(
    dayStart.getFullYear(),
    dayStart.getMonth(),
    dayStart.getDate() + deltaDays,
  );
}

/**
 * Bucket a timestamp into today / yesterday / last 7 days / last 30 days.
 * Returns `null` when older than 30 calendar days (inclusive of today).
 */
export function classifyHistorySession(
  ts: string,
  now: Date = new Date(),
): Exclude<HistoryTimeGroup, "pinned"> | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const todayStart = startOfDay(now);
  const yesterdayStart = addDays(todayStart, -1);
  const sevenDaysStart = addDays(todayStart, -6);
  const thirtyDaysStart = addDays(todayStart, -29);
  if (d >= todayStart) return "today";
  if (d >= yesterdayStart) return "yesterday";
  if (d >= sevenDaysStart) return "last7days";
  if (d >= thirtyDaysStart) return "last30days";
  return null;
}

/**
 * Group sessions for the right-panel history view.
 * Pinned sessions bypass the 30-day window and stay in `pinned`.
 */
export function groupHistorySessions(
  sessions: SessionDescriptor[],
  now: Date = new Date(),
): Partial<Record<HistoryTimeGroup, SessionDescriptor[]>> {
  const groups: Partial<Record<HistoryTimeGroup, SessionDescriptor[]>> = {};
  for (const s of sessions) {
    if (s.pinned) {
      (groups.pinned ??= []).push(s);
      continue;
    }
    const group = classifyHistorySession(s.updated_at ?? s.created_at, now);
    if (!group) continue;
    (groups[group] ??= []).push(s);
  }
  if (groups.pinned && groups.pinned.length > 1) {
    groups.pinned.sort((a, b) => {
      const aTs = a.pinned_at ? Date.parse(a.pinned_at) : 0;
      const bTs = b.pinned_at ? Date.parse(b.pinned_at) : 0;
      return bTs - aTs;
    });
  }
  return groups;
}
