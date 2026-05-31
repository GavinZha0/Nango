/**
 * Client-safe wire shapes for `GET /api/schedules/[id]/runs`.
 *
 * Lives in its own file because the route module is `server-only`;
 * importing types from there into a client bundle would be a
 * compile-time hazard.
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
   * One-line text. Prefers `errorMessage` on failure, otherwise the
   * natural-language `outputSummary`. May be null for runs that
   * finished without either.
   */
  summaryLine: string | null;
}

export interface ScheduleRunsResponse {
  items: ScheduleRunSummary[];
}
