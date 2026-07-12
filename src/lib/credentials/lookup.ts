/**
 * Server-side credential config lookup with in-memory caching (10-min TTL).
 *
 * See docs/cache.md and docs/builtin-runtime.md.
 */

import "server-only";

import { db } from "@/lib/db";
import { CredentialTable, CREDENTIAL_TYPES, type CredentialType } from "@/lib/db/schema";
import { decrypt } from "./crypto";
import { logger } from "@/lib/observability/logger";
import { isSupportedBackend } from "@/lib/backends/types";
import type { BackendId } from "@/lib/backends/types";
import { eq, and, desc } from "drizzle-orm";

// Types

export interface ProviderConfig {
  /** Decrypted bearer token, or null if not found / decryption failed. */
  token: string | null;
  restUrl: string | null;
  aguiUrl: string | null;
}

export interface CredentialTokenConfig {
  token: string | null;
  /** Provider slug stored on the credential row (consistency check). */
  provider: string | null;
}

/** CONTRACT: enabled + serviceType="agent" + provider is registered. */
export interface AgentCredentialConfig extends CredentialFullConfig {
  provider: BackendId;
}

export interface CredentialFullConfig {
  id: string;
  token: string | null;
  restUrl: string | null;
  aguiUrl: string | null;
  /** Provider slug (e.g. "agno", "mastra", "openai"). */
  provider: string | null;
}

/**
 * Generic decrypted-payload view for multi-field credentials
 * (`keypair`: publicKey + secretKey; `oauth_client`: clientId +
 * clientSecret + tokenUrl). CONTRACT: callers validate `fields`
 * against their own Zod schema rather than reaching into untyped
 * properties — keeps lookup callers decoupled from internal layouts.
 */
export interface CredentialFieldsConfig {
  id: string;
  /** Credential type discriminator — see `CREDENTIAL_TYPES`. Used by callers
   *  that need to branch on auth scheme (e.g. legacy bearer vs `oauth_client`
   *  flow). DB rows with an unrecognized type fall back to `"api_key"` so
   *  consumers never see an out-of-range value. */
  type: CredentialType;
  provider: string | null;
  restUrl: string | null;
  /** Empty record if decryption failed. */
  fields: Record<string, unknown>;
}

/** Decoded view of an observability credential (Langfuse) — only the
 *  fields the observability layer cares about. */
export interface ObservabilityCredentialConfig {
  id: string;
  provider: string;
  /** Langfuse host (e.g. https://cloud.langfuse.com), from restUrl. */
  host: string | null;
  publicKey: string | null;
  secretKey: string | null;
}

export interface VoiceCredentialConfig {
  id: string;
  provider: string;
  host: string | null;
  apiKey: string | null;
}

// Helpers

function decryptPayloadSafely(encryptedPayload: string): Record<string, unknown> | null {
  try {
    return decrypt(encryptedPayload);
  } catch (err) {
    logger.error(
      {
        component: "credential-lookup",
        event: "decrypt_failed",
        err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
      },
      "credential payload decryption failed",
    );
    return null;
  }
}

function extractTokenFromEncryptedPayload(encryptedPayload: string): string | null {
  const payload = decryptPayloadSafely(encryptedPayload);
  if (!payload) return null;
  const raw = payload.token ?? payload.key ?? payload.password;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

// In-memory cache — all sub-caches use lru-cache for unified TTL management.
//
// HMR-survival via globalThis: credential reads are on the hottest
// path (every chat turn that resolves a backend or built-in agent
// hits these). A dev-save without pinning would force every active
// session to re-decrypt + re-query the credential row on the next
// turn. The four caches share one holder slot to keep invalidation
// invariants intact (single source of truth for "the credential
// cache").

import { LRUCache } from "lru-cache";
import { getConfigMs } from "@/lib/config";

const DEFAULT_TTL_S = 600;
const SINGLETON = "__singleton__";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const credTtlMs = (): number => getConfigMs("cache.credential.ttl", DEFAULT_TTL_S);

/** Wrapper so lru-cache can store a "checked but none found" sentinel (value.config === null). */
interface ObservabilityCacheEntry { config: ObservabilityCredentialConfig | null; }
interface VoiceCacheEntry { config: VoiceCredentialConfig | null; }

interface CredentialCacheHolder {
  configById: LRUCache<string, CredentialFullConfig>;
  fieldsById: LRUCache<string, CredentialFieldsConfig>;
  agentCredentials: LRUCache<string, CredentialFullConfig[]>;
  observabilityCredential: LRUCache<string, ObservabilityCacheEntry>;
  voiceCredential: LRUCache<string, VoiceCacheEntry>;
  /** Pinned with the caches so dev-time HMR ordering between this
   *  module and `observability/langfuse.ts` can't drop the subscription. */
  invalidationSubscribers: Array<() => void>;
}

declare global {
  var __nangoCredentialCache: CredentialCacheHolder | undefined;
}

const credentialCacheHolder: CredentialCacheHolder =
  (globalThis.__nangoCredentialCache ??= {
    configById: new LRUCache<string, CredentialFullConfig>({ max: 200, ttl: credTtlMs() }),
    fieldsById: new LRUCache<string, CredentialFieldsConfig>({ max: 200, ttl: credTtlMs() }),
    agentCredentials: new LRUCache<string, CredentialFullConfig[]>({ max: 1, ttl: credTtlMs() }),
    observabilityCredential: new LRUCache<string, ObservabilityCacheEntry>({ max: 1, ttl: credTtlMs() }),
    voiceCredential: new LRUCache<string, VoiceCacheEntry>({ max: 4, ttl: credTtlMs() }),
    invalidationSubscribers: [],
  });

if (!credentialCacheHolder.voiceCredential) {
  credentialCacheHolder.voiceCredential = new LRUCache<string, VoiceCacheEntry>({ max: 4, ttl: credTtlMs() });
}

const configByIdCache = credentialCacheHolder.configById;
const fieldsByIdCache = credentialCacheHolder.fieldsById;
const agentCredentialsCache = credentialCacheHolder.agentCredentials;
const observabilityCredentialCache = credentialCacheHolder.observabilityCredential;
const voiceCredentialCache = credentialCacheHolder.voiceCredential;

/** Subscribers notified on `invalidateCredentialCache()`. Used by
 *  downstream caches that key off credential data (Langfuse client
 *  singleton in observability/langfuse.ts). Lazy registration so a
 *  module never imported never incurs cost. Pinned via the holder
 *  above so HMR doesn't silently drop subscriptions. */
const cacheInvalidationSubscribers: Array<() => void> =
  credentialCacheHolder.invalidationSubscribers;

export function onCredentialCacheInvalidated(cb: () => void): void {
  cacheInvalidationSubscribers.push(cb);
}

/** Clear all credential caches. Call after any credential write. */
export function invalidateCredentialCache(): void {
  const sizeBefore = configByIdCache.size;
  configByIdCache.clear();
  agentCredentialsCache.clear();
  fieldsByIdCache.clear();
  observabilityCredentialCache.clear();
  voiceCredentialCache.clear();
  for (const cb of cacheInvalidationSubscribers) {
    try {
      cb();
    } catch (err) {
      logger.error(
        {
          component: "credential-lookup",
          event: "subscriber_failed",
          err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
        },
        "credential cache invalidation subscriber threw",
      );
    }
  }
  logger.debug(
    { component: "credential-lookup", event: "cache_invalidated", sizeBefore },
    "credential cache invalidated",
  );
}

/** Current sizes of each sub-cache. Used by `cache/health.ts`. */
export function _cacheSizes(): {
  config: number;
  fields: number;
  agents: number;
  observability: number;
  voice: number;
} {
  return {
    config: configByIdCache.size,
    fields: fieldsByIdCache.size,
    agents: agentCredentialsCache.size,
    observability: observabilityCredentialCache.size,
    voice: voiceCredentialCache.size,
  };
}

// Public API

/**
 * Latest enabled credential row for `provider`. Used by callers that
 * key by provider slug rather than credential id.
 */
export async function getProviderConfig(provider: string): Promise<ProviderConfig> {
  const rows = await db
    .select({
      encryptedPayload: CredentialTable.encryptedPayload,
      restUrl: CredentialTable.restUrl,
      aguiUrl: CredentialTable.aguiUrl,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.provider, provider),
        eq(CredentialTable.enabled, true),
      )
    )
    .orderBy(desc(CredentialTable.createdAt))
    .limit(1);

  if (rows.length === 0) return { token: null, restUrl: null, aguiUrl: null };

  const row = rows[0];
  const token = extractTokenFromEncryptedPayload(row.encryptedPayload);

  return {
    token,
    restUrl: row.restUrl ?? null,
    aguiUrl: row.aguiUrl ?? null,
  };
}

export async function getCredentialTokenById(credentialId: string): Promise<CredentialTokenConfig> {
  const cached: CredentialFullConfig | undefined = configByIdCache.get(credentialId);
  if (cached) return { token: cached.token, provider: cached.provider };

  const rows = await db
    .select({
      encryptedPayload: CredentialTable.encryptedPayload,
      provider: CredentialTable.provider,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.id, credentialId),
        eq(CredentialTable.enabled, true),
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return { token: null, provider: null };
  }

  const row = rows[0];
  return {
    token: extractTokenFromEncryptedPayload(row.encryptedPayload),
    provider: row.provider ?? null,
  };
}

export async function getCredentialConfigById(credentialId: string): Promise<CredentialFullConfig | null> {
  const cached: CredentialFullConfig | undefined = configByIdCache.get(credentialId);
  if (cached) return cached;

  const rows = await db
    .select({
      id: CredentialTable.id,
      encryptedPayload: CredentialTable.encryptedPayload,
      restUrl: CredentialTable.restUrl,
      aguiUrl: CredentialTable.aguiUrl,
      provider: CredentialTable.provider,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.id, credentialId),
        eq(CredentialTable.enabled, true),
      )
    )
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  const config: CredentialFullConfig = {
    id: row.id,
    token: extractTokenFromEncryptedPayload(row.encryptedPayload),
    restUrl: row.restUrl ?? null,
    aguiUrl: row.aguiUrl ?? null,
    provider: row.provider ?? null,
  };

  configByIdCache.set(credentialId, config);
  return config;
}

/**
 * SECURITY: strict guard for backend-agent entrypoints. Returns null
 * unless: enabled + serviceType="agent" + provider is registered.
 *
 * INTENTIONALLY bypasses configByIdCache on read — the cache stores
 * CredentialFullConfig which lacks the serviceType/provider guarantees
 * this function enforces. The cache.set() at the end is a warm-up
 * side-effect for getCredentialConfigById() callers only.
 */
export async function getAgentCredentialConfigById(
  credentialId: string,
): Promise<AgentCredentialConfig | null> {
  const rows = await db
    .select({
      id: CredentialTable.id,
      encryptedPayload: CredentialTable.encryptedPayload,
      restUrl: CredentialTable.restUrl,
      aguiUrl: CredentialTable.aguiUrl,
      provider: CredentialTable.provider,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.id, credentialId),
        eq(CredentialTable.enabled, true),
        eq(CredentialTable.serviceType, "agent"),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  if (!isSupportedBackend(row.provider)) return null;

  const config: AgentCredentialConfig = {
    id: row.id,
    token: extractTokenFromEncryptedPayload(row.encryptedPayload),
    restUrl: row.restUrl ?? null,
    aguiUrl: row.aguiUrl ?? null,
    provider: row.provider,
  };

  configByIdCache.set(credentialId, config);
  return config;
}

/** All enabled agent-type credentials, cached. Also populates
 *  per-id cache as a side-effect. */
export async function getAllAgentCredentials(): Promise<CredentialFullConfig[]> {
  const cached: CredentialFullConfig[] | undefined = agentCredentialsCache.get(SINGLETON);
  if (cached) return cached;

  const rows = await db
    .select({
      id: CredentialTable.id,
      encryptedPayload: CredentialTable.encryptedPayload,
      restUrl: CredentialTable.restUrl,
      aguiUrl: CredentialTable.aguiUrl,
      provider: CredentialTable.provider,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "agent"),
        eq(CredentialTable.enabled, true),
      )
    )
    .orderBy(desc(CredentialTable.createdAt));

  const configs: CredentialFullConfig[] = rows.map((row) => ({
    id: row.id,
    token: extractTokenFromEncryptedPayload(row.encryptedPayload),
    restUrl: row.restUrl ?? null,
    aguiUrl: row.aguiUrl ?? null,
    provider: row.provider ?? null,
  }));

  agentCredentialsCache.set(SINGLETON, configs);

  // Cross-cache fill: warm configByIdCache so subsequent per-id lookups hit.
  for (const cfg of configs) {
    configByIdCache.set(cfg.id, cfg);
  }

  return configs;
}

/**
 * Full decrypted payload as a generic record (cached). For multi-field
 * credential types (`keypair`, `oauth_client`, …) where the legacy
 * `token ?? key ?? password` extractor would discard fields the caller
 * actually needs. CONTRACT: returns null on missing / disabled;
 * empty `fields` on decryption failure (already logged).
 */
export async function getCredentialFieldsById(
  credentialId: string,
): Promise<CredentialFieldsConfig | null> {
  const cached: CredentialFieldsConfig | undefined = fieldsByIdCache.get(credentialId);
  if (cached) return cached;

  const rows = await db
    .select({
      id: CredentialTable.id,
      type: CredentialTable.type,
      encryptedPayload: CredentialTable.encryptedPayload,
      restUrl: CredentialTable.restUrl,
      provider: CredentialTable.provider,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.id, credentialId),
        eq(CredentialTable.enabled, true),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  // Narrow the DB's free-form text to the known union. Unknown values get
  // mapped to "api_key" so the legacy `payload.token ?? key ?? password`
  // extractor path takes over — preserving today's behavior for any rows
  // written before a new type variant was added to the enum.
  const narrowedType: CredentialType =
    (CREDENTIAL_TYPES as readonly string[]).includes(row.type)
      ? (row.type as CredentialType)
      : "api_key";

  const config: CredentialFieldsConfig = {
    id: row.id,
    type: narrowedType,
    provider: row.provider ?? null,
    restUrl: row.restUrl ?? null,
    fields: decryptPayloadSafely(row.encryptedPayload) ?? {},
  };

  fieldsByIdCache.set(credentialId, config);
  return config;
}

/** First enabled observability credential. CONTRACT: returns null
 *  when none enabled; observability layer treats null as "tracing
 *  disabled" and short-circuits silently. */
export async function getEnabledObservabilityCredential(): Promise<ObservabilityCredentialConfig | null> {
  const cached: ObservabilityCacheEntry | undefined = observabilityCredentialCache.get(SINGLETON);
  if (cached) return cached.config;

  const rows = await db
    .select({
      id: CredentialTable.id,
      encryptedPayload: CredentialTable.encryptedPayload,
      restUrl: CredentialTable.restUrl,
      provider: CredentialTable.provider,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "observability"),
        eq(CredentialTable.enabled, true),
      ),
    )
    .orderBy(desc(CredentialTable.createdAt))
    .limit(1);

  if (rows.length === 0) {
    observabilityCredentialCache.set(SINGLETON, { config: null });
    return null;
  }

  const row = rows[0];
  const fields = decryptPayloadSafely(row.encryptedPayload) ?? {};
  const config: ObservabilityCredentialConfig = {
    id: row.id,
    provider: row.provider ?? "",
    host: row.restUrl ?? null,
    publicKey: typeof fields.publicKey === "string" ? fields.publicKey : null,
    secretKey: typeof fields.secretKey === "string" ? fields.secretKey : null,
  };

  observabilityCredentialCache.set(SINGLETON, { config });
  return config;
}

export async function getEnabledVoiceCredentialById(credentialId: string): Promise<VoiceCredentialConfig | null> {
  if (!UUID_RE.test(credentialId)) {
    return null;
  }
  const cacheKey = `voice:id:${credentialId}`;
  const cached: VoiceCacheEntry | undefined = voiceCredentialCache.get(cacheKey);
  if (cached) {
    if (cached.config && !cached.config.apiKey) {
      voiceCredentialCache.delete(cacheKey);
    } else {
      return cached.config;
    }
  }

  const rows = await db
  .select({
    id: CredentialTable.id,
    encryptedPayload: CredentialTable.encryptedPayload,
    restUrl: CredentialTable.restUrl,
    provider: CredentialTable.provider,
  })
  .from(CredentialTable)
  .where(
    and(
      eq(CredentialTable.serviceType, "voice"),
      eq(CredentialTable.id, credentialId),
      eq(CredentialTable.enabled, true),
    ),
  )
  .limit(1);

  const match = rows[0];

  if(!match) {
    voiceCredentialCache.set(cacheKey, { config: null });
    return null;
  }
  
  const fields = decryptPayloadSafely(match.encryptedPayload) ?? {};
  const apiKey: string | null = typeof fields.apiKey === "string"
  ? fields.apiKey
  : typeof fields.token === "string"
  ? fields.token
  : typeof fields.key === "string"
  ? fields.key
  : null;
    
  const config: VoiceCredentialConfig = {
    id: match.id,
    provider: match.provider ?? "",
    host: match.restUrl ?? null,
    apiKey: apiKey,
  };
  
  voiceCredentialCache.set(cacheKey, { config });
  return config;
}