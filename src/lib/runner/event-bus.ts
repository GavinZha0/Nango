/**
 * In-process pub/sub for runner-driven events.
 *
 * @see docs/orchestrator.md#11-implementation-details-and-quirks
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

export interface NotificationCreatedEvent {
  kind: "notification";
  notification: NotificationEntity;
}

export type RunnerEvent = RunFinalizedEvent | NotificationCreatedEvent;

type Subscriber = (event: RunnerEvent) => void;

// QUIRK: globalThis slot so hot-reload during dev (`next dev` may
// re-evaluate the module body) doesn't fork the registry.
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
      // Drop and continue so a single broken handler doesn't starve
      // the rest of the user's tabs.
    }
  }
}
