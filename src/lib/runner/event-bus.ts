/**
 * In-process pub/sub for runner-driven events.
 *
 * See docs/runner-events.md.
 */

import "server-only";

import type {
  EntityRunStatus,
  NotificationEntity,
} from "@/lib/db/schema";

export interface RunFinalizedEvent {
  kind: "run_finalized";
  runId: string;
  ownerId: string;
  status: Extract<EntityRunStatus, "succeeded" | "failed">;
  /** Cheap text the UI shows in a toast without re-fetching the run
   *  row. Truncated server-side to keep SSE frames small. */
  preview?: string;
}

export interface RunStartedEvent {
  kind: "run_started";
  runId: string;
  ownerId: string;
  entityId: string;
  entityKind: string;
  startedAt: Date;
}

export interface NotificationCreatedEvent {
  kind: "notification";
  notification: NotificationEntity;
}

/**
 * Verification subsystem frames (lifted into the runner bus so the
 * existing `/api/runs/stream` SSE endpoint can multiplex without a
 * second per-owner channel registry). Each frame carries its own
 * `topic: "verification_run"` so the client filters cheaply.
 *
 * V1 frames are NOT durable — they exist only as live SSE updates.
 * The user-facing source of truth for past runs is the
 * `verification_run` / `verification_case_result` tables, not these
 * frames. `id:` is intentionally NOT emitted for them by
 * `/api/runs/stream` so EventSource auto-reconnect treats them as
 * informational (same convention as `run_finalized`).
 *
 * See docs/verification.md.
 */
export interface VerificationRunEvent {
  kind: "verification";
  ownerId: string;
  frame: VerificationFrame;
}

import type { VerificationFrame } from "@/lib/verification/types";
export type { VerificationFrame };

/**
 * Evaluation subsystem frames — same multiplexing pattern as
 * verification. See docs/evaluation.md.
 */
export interface EvaluationRunEvent {
  kind: "evaluation";
  ownerId: string;
  frame: {
    topic: "evaluation_run";
    kind: string;
    runId: string;
    [key: string]: unknown;
  };
}

export type RunnerEvent =
  | RunStartedEvent
  | RunFinalizedEvent
  | NotificationCreatedEvent
  | VerificationRunEvent
  | EvaluationRunEvent;

type Subscriber = (event: RunnerEvent) => void;

// globalThis slot so dev hot-reload doesn't fork the registry.
const GLOBAL_KEY = Symbol.for("nango.runner.eventBus");
interface RegistryHolder {
  byOwner: Map<string, Set<Subscriber>>;
}
const holder: RegistryHolder = (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { byOwner: new Map() };
  return g[GLOBAL_KEY] as RegistryHolder;
})();

/** CONTRACT: caller MUST invoke the returned unsubscribe when the
 *  connection closes. */
export function subscribe(ownerId: string, fn: Subscriber): () => void {
  let set = holder.byOwner.get(ownerId);
  if (!set) {
    set = new Set();
    holder.byOwner.set(ownerId, set);
  }
  set.add(fn);
  return () => {
    const s = holder.byOwner.get(ownerId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) holder.byOwner.delete(ownerId);
  };
}

/** Fan event out to every subscriber for `ownerId`. CONTRACT: no-op
 *  when nobody listens — the DB row is the source of truth, runner
 *  doesn't gate persistence on delivery. */
export function publish(ownerId: string, event: RunnerEvent): void {
  const set = holder.byOwner.get(ownerId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      // One broken handler must not starve the rest.
    }
  }
}
