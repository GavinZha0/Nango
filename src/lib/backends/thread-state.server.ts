import "server-only";

import { LRUCache } from "lru-cache";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { BackendThreadStateTable } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "backend-thread-state" });

/**
 * Provider keys used inside the JSONB `state` column. Adding a new
 * @see lib/db/schema.ts BackendThreadStateTable for column doc.
 */
export type BackendProviderKey = "dify";

/** Per-provider sub-shape. `object` (not `Record<string, unknown>`) so declared interfaces satisfy without index sig. */
type ProviderState = object;

/** Shape of the JSONB column itself: a map keyed by {@link BackendProviderKey}. */
type StateShape = Partial<Record<BackendProviderKey, ProviderState>>;

interface CacheEntry {
  state: StateShape;
}

/**
 * Process-local LRU cache (true access-order eviction via `lru-cache`).
 * Persisted table is source of truth; cache avoids round-trips.
 * Keys: `${credentialId}:${threadId}`. No TTL — the process is the
 * single writer, so the cache is always authoritative.
 *
 * QUIRK: HMR-survival via globalThis — dev save would otherwise add
 * one DB query per chat turn.
 */
declare global {
  var __nangoBackendThreadStateCache: LRUCache<string, CacheEntry> | undefined;
}
import { getConfigNumber } from "@/lib/config";

const DEFAULT_CACHE_MAX = 5_000;
const cache: LRUCache<string, CacheEntry> =
  (globalThis.__nangoBackendThreadStateCache ??= new LRUCache({
    max: getConfigNumber("cache.thread_state.max", DEFAULT_CACHE_MAX),
  }));

function cacheKey(credentialId: string, threadId: string): string {
  return `${credentialId}:${threadId}`;
}

/**
 * Read provider sub-state for `(credentialId, threadId, provider)`.
 * Lazy-hydrates from DB on first miss. Returns `undefined` for no row
 * or no provider entry (both mean "fresh upstream session").
 *
 * Never throws on DB error: treats as cache miss to keep chat stream
 * alive. Worst case: one extra upstream conversation; Dify bridge
 * fallback handles gracefully.
 */
export async function getThreadProviderState<S extends ProviderState>(
  credentialId: string,
  threadId: string,
  provider: BackendProviderKey,
): Promise<S | undefined> {
  const k = cacheKey(credentialId, threadId);
  const hit = cache.get(k);
  if (hit) {
    return hit.state[provider] as S | undefined;
  }

  let state: StateShape;
  try {
    const rows = await db
      .select({ state: BackendThreadStateTable.state })
      .from(BackendThreadStateTable)
      .where(
        and(
          eq(BackendThreadStateTable.credentialId, credentialId),
          eq(BackendThreadStateTable.threadId, threadId),
        ),
      )
      .limit(1);
    state = (rows[0]?.state as StateShape | undefined) ?? {};
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        credentialId,
        threadId,
        provider,
      },
      "thread-state: lookup failed; treating as miss",
    );
    return undefined;
  }

  cache.set(k, { state });
  return state[provider] as S | undefined;
}

/**
 * Persist `patch` into the `(credentialId, threadId).state[provider]`
 * sub-object, merging shallowly with any existing value. Updates the
 * in-memory cache atomically with the DB write.
 *
 * Fire-and-forget at call sites: callers should NOT await this on
 * the chat hot path; a DB hiccup must not block the bridge stream.
 * Cache is updated synchronously regardless of DB outcome so the
 * current process at least reuses the value within its lifetime.
 *
 * RACE: two concurrent writes for the same (cred, thread) on
 * different providers are safe because the SQL `state ||
 * jsonb_build_object(...)` semantics merge at the top level. Two
 * writes to the SAME provider race; last-write-wins, which matches
 * Dify's own conv_id semantics — the most recent `message_end`
 * wins.
 */
export async function setThreadProviderState(
  credentialId: string,
  threadId: string,
  provider: BackendProviderKey,
  patch: ProviderState,
): Promise<void> {
  const k = cacheKey(credentialId, threadId);

  // Cache update first — even if the DB write fails, the current
  // process should keep reusing the captured token until restart.
  const existing = cache.get(k)?.state ?? {};
  const merged: StateShape = {
    ...existing,
    [provider]: { ...(existing[provider] ?? {}), ...patch },
  };
  cache.set(k, { state: merged });

  try {
    await db
      .insert(BackendThreadStateTable)
      .values({
        credentialId,
        threadId,
        state: merged,
      })
      .onConflictDoUpdate({
        target: [
          BackendThreadStateTable.credentialId,
          BackendThreadStateTable.threadId,
        ],
        set: {
          state: merged,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        credentialId,
        threadId,
        provider,
      },
      "thread-state: persist failed; cache retained but next process will miss",
    );
  }
}

/** Current entry count. Used by `cache/health.ts`. */
export function _cacheSize(): number {
  return cache.size;
}

/** @internal Test-only: reset the in-memory cache. */
export function __resetThreadStateCacheForTests(): void {
  cache.clear();
}
