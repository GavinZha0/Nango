/**
 * Thread-/run-level metric helpers shared between the admin thread
 * list and detail endpoints. Kept dependency-free so they remain
 * unit-testable without a database.
 */

/**
 * Run-status priority order from worst to best. Used to choose ONE
 * status to surface for a thread when its runs disagree, e.g. tinting
 * the task column on the thread list or picking the badge for the
 * thread detail summary card.
 *
 * Lower index = wins. "failed" beats "succeeded"; "running" beats
 * "succeeded" (an in-flight thread is more interesting than a finished
 * one); "cancelled" sits below "running"/"paused" because cancellation
 * is a terminal outcome an admin generally wants to surface but is
 * less actionable than active states.
 *
 * Order is mirrored as a runtime const + as the documented colour
 * priority in the client component, so changes here MUST also update
 * the client (otherwise the filter and the colour disagree).
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
 * statuses fall through to "succeeded" so the caller never has to
 * handle the empty case.
 */
export function pickWorstStatus(statuses: ReadonlyArray<string>): string {
  for (const s of STATUS_PRIORITY) {
    if (statuses.includes(s)) return s;
  }
  return statuses[0] ?? "succeeded";
}

/**
 * Compute wall-clock duration in milliseconds between two timestamps.
 *
 * Accepts ISO strings or `Date` objects on either side. Returns `null`
 * when either bound is missing, unparseable, or the end is before the
 * start — callers display "—" for that case rather than a negative or
 * NaN number.
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
