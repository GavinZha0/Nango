/**
 * Thread-/run-level metric helpers shared between the admin thread
 * list and detail endpoints. Dependency-free so they remain unit-
 * testable without a database.
 */

/**
 * Run-status priority, worst → best. Used to pick ONE status to
 * surface when a thread's runs disagree (status column, badge tint).
 *
 * MUST stay in sync with the client component's colour priority —
 * the filter and the colour use the same order; changes here need a
 * matching client-side update.
 */
export const STATUS_PRIORITY: ReadonlyArray<string> = [
  "failed",
  "running",
  "awaiting_input",
  "paused",
  "queued",
  "cancelled",
  "succeeded",
];

/**
 * Pick the highest-priority status from a list. Empty / unknown
 * statuses fall through to "succeeded" so callers never handle the
 * empty case.
 */
export function pickWorstStatus(statuses: ReadonlyArray<string>): string {
  for (const s of STATUS_PRIORITY) {
    if (statuses.includes(s)) return s;
  }
  return statuses[0] ?? "succeeded";
}

/**
 * Wall-clock duration in milliseconds between two timestamps. Returns
 * `null` when either bound is missing, unparseable, or the end is
 * before the start — callers render "—" for that case.
 */
export function durationMsBetween(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}
