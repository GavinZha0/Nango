/**
 * Task polling history and failure-handling helpers for the MCP test inspector.
 *
 * Keeps the sliding-window history cap (`mcp.task_poll_history_limit`),
 * monotonic sequence / total-poll counting, and non-2xx stop conditions
 * pure and unit-testable outside React state updaters.
 */

export const DEFAULT_TASK_POLL_HISTORY_LIMIT = 5;
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;
export const MAX_TASK_POLL_ATTEMPTS = 300;

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface TaskView {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  retentionMs: number | null;
  suggestedPollIntervalMs?: number;
  ttl: number | null;
  pollInterval?: number;
  pollCount?: number;
  result?: unknown;
  raw: Record<string, unknown>;
  extensions: Record<string, unknown>;
}

export interface TaskPollRecord {
  seq: number;
  timestamp: string;
  status: TaskStatus;
  statusMessage?: string;
  suggestedPollIntervalMs?: number;
  retentionMs?: number | null;
  data: TaskView;
}

/** True when a task has reached a terminal lifecycle state and must stop polling. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Clamp a raw config number to a positive integer (`>= 1`), falling back to
 * {@link DEFAULT_TASK_POLL_HISTORY_LIMIT} when non-finite or `<= 0`.
 */
export function normalizePollHistoryLimit(
  raw: unknown,
  fallback: number = DEFAULT_TASK_POLL_HISTORY_LIMIT,
): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || num < 1) {
    return Math.max(1, Math.floor(fallback));
  }
  return Math.floor(num);
}

/**
 * Append a new poll snapshot for a task while retaining at most the most
 * recent `limit` entries.
 *
 * - Sequence numbers (`seq`) continue incrementing monotonically (`last.seq + 1`)
 *   even after older entries are evicted, so the last record's `seq` always
 *   equals the total number of snapshots recorded for the task.
 * - If the last recorded snapshot is already terminal, no duplicate terminal
 *   snapshot is appended (only the retention cap is enforced).
 */
export function appendTaskPollRecord(
  existing: readonly TaskPollRecord[],
  detail: TaskView,
  limit: number,
  nowIso: string = new Date().toISOString(),
): TaskPollRecord[] {
  const cap = normalizePollHistoryLimit(limit);
  const last = existing[existing.length - 1];
  if (last && isTerminalTaskStatus(last.status)) {
    return existing.length > cap ? existing.slice(-cap) : [...existing];
  }

  const nextSeq = (last?.seq ?? 0) + 1;
  const record: TaskPollRecord = {
    seq: nextSeq,
    timestamp: nowIso,
    status: detail.status,
    statusMessage: detail.statusMessage,
    suggestedPollIntervalMs: detail.suggestedPollIntervalMs ?? detail.pollInterval,
    retentionMs: detail.retentionMs,
    data: detail,
  };

  return [...existing, record].slice(-cap);
}

/**
 * Total number of poll snapshots recorded for a task over its lifetime.
 * Uses the monotonic `seq` of the newest retained snapshot so the badge
 * beside `taskId` reflects the true poll count rather than the capped
 * display window `N`.
 */
export function getTotalPollCount(history: readonly TaskPollRecord[] | undefined): number {
  if (!history || history.length === 0) return 1;
  return history[history.length - 1].seq;
}

/**
 * Decide whether a failed poll attempt (`!res.ok` or network error) should
 * transition the task into a local terminal `failed` state to stop polling.
 *
 * - Definitive client/resource errors (`400`, `401`, `403`, `404`, `410`) stop
 *   immediately on the first failure.
 * - Transient upstream/network errors (`502`, `503`, `504`, `500`, `null`)
 *   stop once `consecutiveFailures >= maxFailures`.
 */
export function shouldStopPollingOnFailure(
  httpStatus: number | null,
  consecutiveFailures: number,
  maxFailures: number = MAX_CONSECUTIVE_POLL_FAILURES,
): boolean {
  if (
    httpStatus === 400 ||
    httpStatus === 401 ||
    httpStatus === 403 ||
    httpStatus === 404 ||
    httpStatus === 410
  ) {
    return true;
  }
  return consecutiveFailures >= Math.max(1, maxFailures);
}

/**
 * Synthesize a terminal `failed` TaskView when polling is aborted due to
 * unrecoverable or repeated errors, allowing the UI and auto-poll effect to
 * stop spinning and display the failure reason.
 */
export function buildFailedTaskViewFromPollError(
  prev: TaskView | undefined,
  taskId: string,
  errorMessage: string,
  nowIso: string = new Date().toISOString(),
): TaskView {
  const prevRaw = prev?.raw ?? {};
  return {
    taskId,
    status: "failed",
    statusMessage: errorMessage,
    createdAt: prev?.createdAt ?? nowIso,
    lastUpdatedAt: nowIso,
    retentionMs: prev?.retentionMs ?? null,
    suggestedPollIntervalMs: prev?.suggestedPollIntervalMs,
    pollInterval: prev?.pollInterval,
    ttl: prev?.ttl ?? null,
    raw: {
      ...prevRaw,
      taskId,
      status: "failed",
      error: { message: errorMessage },
    },
    extensions: prev?.extensions ?? {},
  };
}
