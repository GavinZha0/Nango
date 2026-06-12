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
    // Fire-and-collect — never block the engine event tape on
    // DB latency, but track the promise so flush() can await it.
    const p = recordEvent(runId, currentSeq, type, event).catch(
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
