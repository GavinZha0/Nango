/**
 * EntityCatalog — server-side entity discovery + caching (control plane).
 * @see docs/cache.md §2.5
 */

import "server-only";

import { LRUCache } from "lru-cache";

import { getConfigMs, getConfigNumber } from "@/lib/config";
import { getCredentialConfigById } from "@/lib/credentials/lookup";
import { childLogger } from "@/lib/observability/logger";
import { BACKENDS } from "./registry.server";
import { isSupportedBackend } from "./types";
import type { EntityDescriptor } from "./types";

const log = childLogger({ component: "entity-catalog" });

// HMR-survival via globalThis: the UI's agent picker warms this on
// mount, and the control plane (supervisor catalog rendering,
// schedule validation) reads it on every request. A dev save without
// pinning would force every chat turn that follows the save to
// re-fetch the entity list from each upstream platform.
declare global {
  var __nangoEntityCatalogCache: LRUCache<string, EntityDescriptor[]> | undefined;
}

const cache: LRUCache<string, EntityDescriptor[]> = (globalThis.__nangoEntityCatalogCache ??= new LRUCache<string, EntityDescriptor[]>({
  max: getConfigNumber("cache.entity_catalog.max", 100),
  ttl: getConfigMs("cache.entity_catalog.ttl", 600),
  // Let in-flight fetches complete even when the key is deleted by
  // invalidate(). Without this, cache.delete() during a pending
  // fetchMethod aborts the fetch and rejects waiting callers.
  // NOTE: do NOT add allowStaleOnFetchAbort — that would resolve
  // waiting callers immediately with undefined instead of the result.
  ignoreFetchAbort: true,
  // lru-cache contract: concurrent fetch() calls for the same key
  // share one underlying Promise (built-in dedup). If fetchMethod
  // throws, the result is NOT cached and the next fetch() retries.
  fetchMethod: async (credentialId: string): Promise<EntityDescriptor[] | undefined> => {
    const cfg = await getCredentialConfigById(credentialId);
    if (!cfg) return undefined; // undefined → not cached → retry on next call

    if (!isSupportedBackend(cfg.provider)) {
      log.warn(
        { event: "unsupported_provider", credentialId, provider: cfg.provider },
        "credential provider is not registered; entity table left empty",
      );
      return [];
    }

    if (!cfg.restUrl || !cfg.token) {
      log.warn(
        { event: "missing_credential_fields", credentialId, provider: cfg.provider },
        "credential missing restUrl or token; cannot resolve entity table",
      );
      return [];
    }

    const fetchEntities = BACKENDS[cfg.provider].controlPlane.fetchEntities;
    return fetchEntities(
      credentialId,
      cfg.restUrl.replace(/\/+$/, ""),
      cfg.token,
    );
  },
}));

/**
 * Returns `null` when credential is missing/disabled (not cached).
 * Returns `[]` when credential is valid but has no entities (cached).
 * Concurrent callers for the same credentialId share one fetch.
 */
async function list(credentialId: string): Promise<EntityDescriptor[] | null> {
  const result = await cache.fetch(credentialId);
  return result ?? null;
}

/**
 * Drop a credential's row, or clear the whole cache when called
 * without an id (tests / admin tools).
 * @see docs/backend-integration.md#entity-catalog-entity-catalogts
 */
function invalidate(credentialId?: string): void {
  if (!credentialId) {
    cache.clear();
    return;
  }
  cache.delete(credentialId);
}

/** Current entry count. Used by `cache/health.ts`. */
function _cacheSize(): number {
  return cache.size;
}

export const EntityCatalog = {
  list,
  invalidate,
  _cacheSize,
} as const;
