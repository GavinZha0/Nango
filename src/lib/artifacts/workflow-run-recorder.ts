/**
 * Persist a workflow refresh execution to `entity_run` +
 * `entity_run_event`. Active only on `forceFresh: true` (passive
 * GETs would flood the table). All DB writes are best-effort —
 * the recorded run must not affect the workflow execution itself.
 * Engine-event → persisted-row mapping is in
 * `mapEngineEventToEventType` below. See docs/workflow.md.
 */

import "server-only";

import { logger as observabilityLogger } from "@/lib/observability/logger";
import type { EntityRunEventType } from "@/lib/db/schema";
import {
  finalizeRun,
  recordEvent,
  recordRunStart,
} from "@/lib/runner/event-store";
import type { WorkflowEngineEvent } from "@/lib/workflows/engine";

const log = observabilityLogger.child({ component: "workflow-run-recorder" });

export interface WorkflowRunRecorder {
  /** Engine `runId` to pass into `inProcessWorkflowEngine.execute`.
   *  Equals the persisted `entity_run.id` so events line up with
   *  the row downstream. */
  readonly runId: string;

  /** Drop-in replacement for `noopEmitEvent`. Failures log; the
   *  caller's `engine.execute` path is not affected. */
  emit(event: WorkflowEngineEvent): void;

  /** Caller invokes after a successful `engine.execute`. */
  succeed(): Promise<void>;

  /** Caller invokes on any thrown error from `engine.execute`.
   *  WorkflowError vs unexpected throws share this path; the
   *  error message lands in `entity_run.error_message`. */
  fail(err: unknown): Promise<void>;
}

export interface StartRecorderArgs {
  workflowId: string;
  /** Optional workflow name used to populate `entity_run.input_task`
   *  with a human-readable label. Falls back to "workflow refresh"
   *  when the caller doesn't have the row's `name`. */
  workflowName?: string;
  ownerId: string;
}

/**
 * Begin recording a workflow refresh. Returns `null` when the
 * initial INSERT fails (DB down, schema drift, etc.) — caller
 * falls back to noop persistence and the run proceeds.
 */
export async function startRecording(
  args: StartRecorderArgs,
): Promise<WorkflowRunRecorder | null> {
  try {
    const row = await recordRunStart({
      initiator: "user", // refresh is a deliberate user action
      entityId: args.workflowId,
      entityKind: "workflow",
      entitySource: "builtin",
      mode: "sync",
      task: args.workflowName
        ? `Refresh workflow: ${args.workflowName}`
        : "Workflow refresh",
      ownerId: args.ownerId,
      // No separate `createdBy` slot for refresh-initiated runs —
      // attribute to the owner. V1 keeps refresh single-owner.
      createdBy: args.ownerId,
    });
    return buildRecorder(row.id);
  } catch (err) {
    log.warn(
      { err, workflowId: args.workflowId, ownerId: args.ownerId },
      "failed to start workflow run record; continuing without persistence",
    );
    return null;
  }
}

function buildRecorder(runId: string): WorkflowRunRecorder {
  let seq = 0;
  /** In-flight event writes. `flush()` awaits all before finalize. */
  const pending: Promise<void>[] = [];

  function emit(event: WorkflowEngineEvent): void {
    const type: EntityRunEventType = mapEngineEventToEventType(event.type);
    const currentSeq = seq++;
    const payload = sanitizeEngineEventForPersistence(event);
    // Fire-and-collect — never block the engine event tape on
    // DB latency, but track the promise so flush() can await it.
    const p = recordEvent(runId, currentSeq, type, payload).catch(
      (err: unknown) => {
        log.error(
          { err, runId, eventType: event.type, seq: currentSeq },
          "failed to persist workflow event",
        );
      },
    );
    pending.push(p);
  }

  /**
   * Await all in-flight event writes. Called before `finalizeRun`
   * so the event timeline is complete when the run status changes.
   * Individual failures are already logged by each emit's catch;
   * this step surfaces any that settled as rejected after the
   * original catch (should not happen, but defensive).
   */
  async function flush(): Promise<void> {
    const results = await Promise.allSettled(pending);
    pending.length = 0;
    let failCount = 0;
    for (const r of results) {
      if (r.status === "rejected") failCount++;
    }
    if (failCount > 0) {
      log.error(
        { runId, failCount, total: results.length },
        "workflow event flush completed with failures",
      );
    }
  }

  async function succeed(): Promise<void> {
    await flush();
    try {
      await finalizeRun(runId, "succeeded");
    } catch (err) {
      log.warn(
        { err, runId },
        "failed to finalize workflow run on success",
      );
    }
  }

  async function fail(err: unknown): Promise<void> {
    await flush();
    const errorMessage: string =
      err instanceof Error ? err.message : String(err);
    try {
      await finalizeRun(runId, "failed", { errorMessage });
    } catch (finalizeErr) {
      log.warn(
        { err: finalizeErr, runId, originalError: errorMessage },
        "failed to finalize workflow run on failure",
      );
    }
  }

  return { runId, emit, succeed, fail };
}

/**
 * Static map from engine event type to persisted row type. Run-
 * level events reuse the existing vocabulary (`started` /
 * `finished` / `error`) so admin run forensics can render workflow
 * runs alongside chat / async runs without a special branch.
 */
export function mapEngineEventToEventType(
  engineType: WorkflowEngineEvent["type"],
): EntityRunEventType {
  switch (engineType) {
    case "workflow_started":
      return "started";
    case "workflow_completed":
      return "finished";
    case "workflow_failed":
      return "error";
    case "workflow_node_attempt_started":
      return "workflow_node_attempt_started";
    case "workflow_node_attempt_failed":
      return "workflow_node_attempt_failed";
    case "workflow_node_completed":
      return "workflow_node_completed";
  }
}

// ─── Bounded Event Summaries ──────────────────────────────────────────

/** Maximum rows to persist in an event payload before summarizing. */
export const MAX_EVENT_PREVIEW_ROWS = 20;

/** Maximum length for string properties in audit events before truncation. */
export const MAX_EVENT_STRING_LENGTH = 10_000;

/** Length of head and tail snippets preserved during string truncation. */
export const EVENT_STRING_HEAD_TAIL_CHARS = 500;

/** Maximum nesting depth for audit event output serialization. */
export const MAX_EVENT_NESTING_DEPTH = 3;

/** Maximum number of keys preserved in any object before truncation. */
export const MAX_EVENT_OBJECT_KEYS = 50;

/** Hard upper bound on serialized event payload size (64KB). */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

/**
 * Truncate oversized string by retaining head and tail snippets.
 * Preserves critical diagnostic messages and stack traces located at the end.
 */
export function truncateHeadTail(
  str: string,
  maxLen = MAX_EVENT_STRING_LENGTH,
  headLen = EVENT_STRING_HEAD_TAIL_CHARS,
  tailLen = EVENT_STRING_HEAD_TAIL_CHARS,
): string {
  if (str.length <= maxLen) return str;
  const truncatedChars = str.length - (headLen + tailLen);
  return `${str.slice(0, headLen)}\n... [truncated ${truncatedChars} chars for audit log] ...\n${str.slice(-tailLen)}`;
}

/**
 * Summarize node outputs for audit event persistence.
 *
 * Prevents multi-megabyte result sets from bloating the append-only
 * entity_run_event table.
 * - Caps row and collection arrays to MAX_EVENT_PREVIEW_ROWS.
 * - Caps object keys to MAX_EVENT_OBJECT_KEYS.
 * - Caps ECharts dataset.source and series[i].data.
 * - Caps long strings retaining head + tail diagnostic snippets (P5).
 * - Restricts recursion depth to MAX_EVENT_NESTING_DEPTH (P6).
 * - Retains metadata (total_rows, returned_rows, dataset_name, schema, etc.).
 */
export function summarizeOutputsForEvent(
  outputs: Record<string, unknown>,
  depth: number = 0,
): Record<string, unknown> {
  if (depth >= MAX_EVENT_NESTING_DEPTH) {
    return { _truncated_depth: true };
  }

  const summarized: Record<string, unknown> = {};
  const allEntries = Object.entries(outputs);
  const totalKeys = allEntries.length;
  const entriesToProcess =
    totalKeys > MAX_EVENT_OBJECT_KEYS
      ? allEntries.slice(0, MAX_EVENT_OBJECT_KEYS)
      : allEntries;

  if (totalKeys > MAX_EVENT_OBJECT_KEYS) {
    summarized._keys_truncated = true;
    summarized._total_keys = totalKeys;
  }

  for (const [key, value] of entriesToProcess) {
    if (key === "rows" && Array.isArray(value)) {
      if (value.length > MAX_EVENT_PREVIEW_ROWS) {
        summarized.rows = value
          .slice(0, MAX_EVENT_PREVIEW_ROWS)
          .map((item) => summarizeNestedValue(item, depth + 1));
        summarized.rows_truncated = true;
        summarized.total_rows =
          outputs.total_rows ?? outputs.row_count ?? value.length;
      } else {
        summarized.rows = value.map((item) =>
          summarizeNestedValue(item, depth + 1),
        );
      }
    } else if (
      key === "option" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const optionObj = value as Record<string, unknown>;
      const summarizedOption: Record<string, unknown> = {};

      for (const [optKey, optVal] of Object.entries(optionObj)) {
        if (optKey === "dataset" && optVal !== null && typeof optVal === "object") {
          if (Array.isArray(optVal)) {
            summarizedOption.dataset = optVal.map((ds) => {
              if (ds !== null && typeof ds === "object") {
                const dsObj = ds as Record<string, unknown>;
                if (Array.isArray(dsObj.source) && dsObj.source.length > MAX_EVENT_PREVIEW_ROWS) {
                  return {
                    ...dsObj,
                    source: dsObj.source.slice(0, MAX_EVENT_PREVIEW_ROWS),
                    source_truncated: true,
                    total_source_items: dsObj.source.length,
                  };
                }
              }
              return summarizeNestedValue(ds, depth + 1);
            });
          } else {
            const ds = optVal as Record<string, unknown>;
            if (Array.isArray(ds.source) && ds.source.length > MAX_EVENT_PREVIEW_ROWS) {
              summarizedOption.dataset = {
                ...ds,
                source: ds.source.slice(0, MAX_EVENT_PREVIEW_ROWS),
                source_truncated: true,
                total_source_items: ds.source.length,
              };
            } else {
              summarizedOption.dataset = summarizeNestedValue(optVal, depth + 1);
            }
          }
        } else if (optKey === "series" && Array.isArray(optVal)) {
          summarizedOption.series = optVal
            .slice(0, MAX_EVENT_PREVIEW_ROWS)
            .map((s) => {
              if (s !== null && typeof s === "object") {
                const sObj = s as Record<string, unknown>;
                if (Array.isArray(sObj.data) && sObj.data.length > MAX_EVENT_PREVIEW_ROWS) {
                  return {
                    ...sObj,
                    data: sObj.data.slice(0, MAX_EVENT_PREVIEW_ROWS),
                    data_truncated: true,
                    total_data_items: sObj.data.length,
                  };
                }
              }
              return summarizeNestedValue(s, depth + 1);
            });
          if (optVal.length > MAX_EVENT_PREVIEW_ROWS) {
            summarizedOption.series_truncated = true;
            summarizedOption.total_series_count = optVal.length;
          }
        } else {
          summarizedOption[optKey] = summarizeNestedValue(optVal, depth + 1);
        }
      }

      summarized.option = summarizedOption;
    } else if (typeof value === "string") {
      if (value.length > MAX_EVENT_STRING_LENGTH) {
        summarized[key] = truncateHeadTail(value);
        summarized[`${key}_truncated`] = true;
        summarized[`${key}_truncated_position`] = "middle";
      } else {
        summarized[key] = value;
      }
    } else if (Array.isArray(value)) {
      if (value.length > MAX_EVENT_PREVIEW_ROWS) {
        summarized[key] = value
          .slice(0, MAX_EVENT_PREVIEW_ROWS)
          .map((item) => summarizeNestedValue(item, depth + 1));
        summarized[`${key}_truncated`] = true;
        summarized[`${key}_total_count`] = value.length;
      } else {
        summarized[key] = value.map((item) =>
          summarizeNestedValue(item, depth + 1),
        );
      }
    } else if (value !== null && typeof value === "object") {
      summarized[key] = summarizeOutputsForEvent(
        value as Record<string, unknown>,
        depth + 1,
      );
    } else {
      summarized[key] = value;
    }
  }

  return summarized;
}

function summarizeNestedValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_EVENT_NESTING_DEPTH) {
    if (Array.isArray(value)) {
      return `[Truncated: array at depth ${depth}]`;
    }
    if (value !== null && typeof value === "object") {
      return { _truncated_depth: true };
    }
    return value;
  }

  if (typeof value === "string") {
    return value.length > MAX_EVENT_STRING_LENGTH
      ? truncateHeadTail(value)
      : value;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_EVENT_PREVIEW_ROWS) {
      return value
        .slice(0, MAX_EVENT_PREVIEW_ROWS)
        .map((item) => summarizeNestedValue(item, depth + 1));
    }
    return value.map((item) => summarizeNestedValue(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    return summarizeOutputsForEvent(value as Record<string, unknown>, depth + 1);
  }

  return value;
}

/**
 * Sanitize workflow engine events before writing to `entity_run_event`.
 * Ensures payload size is strictly bounded (<= 64KB) regardless of data volume.
 */
export function sanitizeEngineEventForPersistence(
  event: WorkflowEngineEvent,
): Record<string, unknown> {
  let sanitized: Record<string, unknown>;
  if (event.type === "workflow_node_completed") {
    sanitized = {
      ...event,
      outputs: summarizeOutputsForEvent(event.outputs),
    };
  } else if (event.type === "workflow_completed") {
    sanitized = {
      ...event,
      output: summarizeOutputsForEvent(event.output),
    };
  } else {
    sanitized = { ...event };
  }

  // Hard payload byte budget check (P0-3 / Problem 2)
  try {
    const jsonStr = JSON.stringify(sanitized);
    const byteLength =
      typeof Buffer !== "undefined"
        ? Buffer.byteLength(jsonStr, "utf8")
        : new TextEncoder().encode(jsonStr).length;

    if (byteLength > MAX_EVENT_PAYLOAD_BYTES) {
      if (sanitized.outputs && typeof sanitized.outputs === "object") {
        sanitized.outputs = {
          _payload_truncated_bytes: true,
          _original_size_bytes: byteLength,
          _budget_bytes: MAX_EVENT_PAYLOAD_BYTES,
          summary:
            "Outputs payload exceeded 64KB hard limit and was truncated for persistence safety.",
        };
      }
      if (sanitized.output && typeof sanitized.output === "object") {
        sanitized.output = {
          _payload_truncated_bytes: true,
          _original_size_bytes: byteLength,
          _budget_bytes: MAX_EVENT_PAYLOAD_BYTES,
          summary:
            "Workflow output exceeded 64KB hard limit and was truncated for persistence safety.",
        };
      }
    }
  } catch {
    // If JSON serialization fails, fall through safely
  }

  return sanitized;
}
