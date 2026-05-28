/**
 * Client-safe wire shapes for `GET /api/schedules/[id]/runs`.
 *
 * Kept out of the route file because that one declares
 * `import "server-only"` — pulling types from it into a client bundle
 * would be a compile-time hazard. This file has no runtime
 * dependencies and is safe to import from React components.
 */

export interface ScheduleRunSummary {
  /** entity_run.id — verbatim so future "open in admin" links don't
   *  need a separate lookup. */
  runId: string;
  /** entity_run.status (succeeded / failed / running / …). */
  status: string;
  /** ISO; null while still in flight. */
  finishedAt: string | null;
  /** ISO; entity_run.created_at, always set. */
  createdAt: string;
  /**
   * One-line text. On failure we prefer `errorMessage` (the user
   * wants to know WHY); otherwise the natural-language
   * `outputSummary`. May be null for runs that finished without
   * either (rare, but possible during a partial outage).
   */
  summaryLine: string | null;
}

export interface ScheduleRunsResponse {
  items: ScheduleRunSummary[];
}
