/**
 * Cache health aggregation for the admin endpoint.
 * @see docs/cache.md §7
 */

import "server-only";

import { agentPool } from "@/lib/builtin-agents";
import { skillPool } from "@/lib/skills";
import { mcpProviderPool } from "@/lib/mcp";
import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { _cacheSize as threadStateCacheSize } from "@/lib/backends/thread-state.server";
import { _cacheSizes as credentialCacheSizes } from "@/lib/credentials/lookup";

export interface CacheHealthReport {
  agentPool: { size: number; max: number };
  skillPool: { size: number; max: number };
  mcpPool: { active: number; creating: number; draining: number };
  entityCatalog: { size: number; max: number };
  credentialLookup: { config: number; fields: number; agents: number; observability: number };
  threadState: { size: number; max: number };
}

/** Snapshot of all six process-wide caches. */
export function getCacheHealth(): CacheHealthReport {
  const mcp = mcpProviderPool._inspect();
  return {
    agentPool: { size: agentPool._size(), max: 500 },
    skillPool: { size: skillPool._size(), max: 500 },
    mcpPool: {
      active: mcp.entries.length,
      creating: mcp.creating.length,
      draining: mcp.draining.length,
    },
    entityCatalog: { size: EntityCatalog._cacheSize(), max: 100 },
    credentialLookup: credentialCacheSizes(),
    threadState: { size: threadStateCacheSize(), max: 5_000 },
  };
}
