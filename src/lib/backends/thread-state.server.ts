/**
 * Per-thread upstream-session token cache, backed by `backend_thread_state`.
 * See docs/backend-integration.md and docs/cache.md.
 */

import "server-only";

import { LRUCache } from "lru-cache";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { BackendThreadStateTable } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "backend-thread-state" });

/** Provider keys used inside the JSONB `state` column. */
export type BackendProviderKey = "dify";

/** Per-provider sub-shape. `object` so declared interfaces satisfy without an index signature. */
type ProviderState = object;

type StateShape = Partial<Record<BackendProviderKey, ProviderState>>;

interface CacheEntry {
  state: StateShape;
}

// HMR-survival via globalThis. DB is source of truth; cache is process-local.
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
 * CONTRACT: never throws — DB errors are treated as cache misses so
 * the chat stream stays alive.
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
 * Persist `patch` into `(credentialId, threadId).state[provider]`,
 * merging shallowly with any existing value. Cache is updated
 * synchronously; DB write is best-effort.
 *
 * CONTRACT: fire-and-forget — callers MUST NOT await this on the
 * chat hot path (a DB hiccup must not block the bridge stream).
 * Concurrent writes to the same provider are last-write-wins.
 */
export async function setThreadProviderState(
  credentialId: string,
  threadId: string,
  provider: BackendProviderKey,
  patch: ProviderState,
): Promise<void> {
  const k = cacheKey(credentialId, threadId);

  // Update cache first so the current process keeps reusing the
  // captured token even if the DB write fails.
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
