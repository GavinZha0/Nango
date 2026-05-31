/**
 * EntityCatalog — server-side entity discovery + caching (control plane).
 * See docs/cache.md and docs/backend-integration.md.
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

// HMR-survival via globalThis — keeps the cache hot across dev saves.
declare global {
  var __nangoEntityCatalogCache: LRUCache<string, EntityDescriptor[]> | undefined;
}

const cache: LRUCache<string, EntityDescriptor[]> = (globalThis.__nangoEntityCatalogCache ??= new LRUCache<string, EntityDescriptor[]>({
  max: getConfigNumber("cache.entity_catalog.max", 100),
  ttl: getConfigMs("cache.entity_catalog.ttl", 600),
  // Let in-flight fetches complete even when the key is deleted by
  // invalidate(). DO NOT add allowStaleOnFetchAbort — that resolves
  // waiting callers with undefined instead of the result.
  ignoreFetchAbort: true,
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
