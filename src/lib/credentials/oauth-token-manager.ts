/**
 * OAuth 2.0 Client Credentials Grant — access token manager.
 * Lazy refresh, concurrency-deduped, three-tier API
 * (`getOAuthAccessToken` / `getOAuthAuthorizationHeader` /
 * `withOAuth`). See docs/cache.md.
 */

import "server-only";

import { LRUCache } from "lru-cache";
import { z } from "zod";

import { getConfigMs } from "@/lib/config";
import { logger } from "@/lib/observability/logger";

import {
  getCredentialFieldsById,
  onCredentialCacheInvalidated,
} from "./lookup";

// ─── Types ─────────────────────────────────────────────────────────────

/**
 * Zod schema for the decrypted payload of an `oauth_client` credential.
 * `scope` is optional — many IdPs accept token requests without a scope
 * (they grant the client's default scope set instead).
 */
const OauthClientFieldsSchema = z.object({
  clientId: z.string().min(1, "clientId is required"),
  clientSecret: z.string().min(1, "clientSecret is required"),
  tokenUrl: z.string().url("tokenUrl must be a valid URL"),
  scope: z.string().optional(),
});
type OauthClientFields = z.infer<typeof OauthClientFieldsSchema>;

interface CachedToken {
  accessToken: string;
  /** Absolute epoch millis when the token expires. */
  expiresAt: number;
}

/**
 * Standard OAuth 2.0 token endpoint response (RFC 6749 §5.1).
 * `expires_in` is in seconds; `token_type` is informational here
 * since we only emit Bearer tokens via the convenience helper.
 */
interface TokenEndpointResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

// ─── Configuration constants ───────────────────────────────────────────

/** Refresh the token if its remaining lifetime is below this threshold.
 *  60s gives downstream requests plenty of room to finish without their
 *  Bearer token expiring mid-flight. */
const REFRESH_SKEW_MS = 60_000;

/** Fallback when the IdP omits `expires_in` (rare but allowed by spec). */
const DEFAULT_EXPIRES_IN_S = 3600;

/** Cache TTL safety net — should be larger than typical access-token
 *  lifetime; the per-entry `expiresAt` check is the real expiry logic. */
const DEFAULT_CACHE_TTL_S = 4 * 60 * 60;

// ─── Internal state ────────────────────────────────────────────────────
//
// HMR-survival via globalThis: tokens are expensive to mint, the
// in-flight Map is the dedupe gate, and `credentialSubscribed`
// keeps re-evaluation from registering a duplicate subscription.

interface OAuthTokenHolder {
  tokenCache: LRUCache<string, CachedToken>;
  inFlight: Map<string, Promise<CachedToken>>;
  credentialSubscribed: boolean;
}

declare global {
  var __nangoOAuthTokenManager: OAuthTokenHolder | undefined;
}

const oauthHolder: OAuthTokenHolder = (globalThis.__nangoOAuthTokenManager ??= {
  tokenCache: new LRUCache<string, CachedToken>({
    max: 200,
    ttl: getConfigMs("cache.oauth_token.ttl", DEFAULT_CACHE_TTL_S),
  }),
  inFlight: new Map<string, Promise<CachedToken>>(),
  credentialSubscribed: false,
});

const tokenCache = oauthHolder.tokenCache;
/** In-flight token requests keyed by credentialId. Used to dedupe
 *  concurrent callers so we hit the token endpoint at most once per
 *  refresh cycle. */
const inFlight = oauthHolder.inFlight;

// Drop all tokens when the credential cache is invalidated (admin
// rotated a secret etc.). Coarse clear-all; a per-id channel can
// be added if precision becomes a problem.
if (!oauthHolder.credentialSubscribed) {
  onCredentialCacheInvalidated(() => {
    if (tokenCache.size === 0) return;
    const sizeBefore = tokenCache.size;
    tokenCache.clear();
    logger.debug(
      { component: "oauth-token-manager", event: "cache_cleared_via_credential_invalidation", sizeBefore },
      "OAuth token cache cleared after credential change",
    );
  });
  oauthHolder.credentialSubscribed = true;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Returns a valid token, hitting the token endpoint (deduped) only
 * when the cached entry is within `REFRESH_SKEW_MS` of expiry.
 * Throws on missing credential, decrypt failure, malformed payload,
 * or non-2xx response from the token endpoint.
 */
export async function getOAuthAccessToken(credentialId: string): Promise<string> {
  const cached: CachedToken | undefined = tokenCache.get(credentialId);
  if (cached !== undefined && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return cached.accessToken;
  }

  const existing: Promise<CachedToken> | undefined = inFlight.get(credentialId);
  if (existing !== undefined) {
    const entry: CachedToken = await existing;
    return entry.accessToken;
  }

  const promise: Promise<CachedToken> = fetchAndCacheToken(credentialId)
    .finally(() => {
      inFlight.delete(credentialId);
    });
  inFlight.set(credentialId, promise);

  const entry: CachedToken = await promise;
  return entry.accessToken;
}

/** Returns `"Bearer <token>"` for direct use as an `Authorization`
 *  header value. */
export async function getOAuthAuthorizationHeader(credentialId: string): Promise<string> {
  const token: string = await getOAuthAccessToken(credentialId);
  return `Bearer ${token}`;
}

/** Clone a `RequestInit` with an `Authorization: Bearer …` header
 *  merged in. Any existing `Authorization` is OVERWRITTEN. */
export async function withOAuth(
  credentialId: string,
  init: RequestInit = {},
): Promise<RequestInit> {
  const authHeader: string = await getOAuthAuthorizationHeader(credentialId);
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: authHeader,
    },
  };
}

/** Force-drop the cached token. Call after a downstream 401 so the
 *  next call re-fetches from the IdP. */
export function invalidateOAuthToken(credentialId: string): void {
  const had: boolean = tokenCache.delete(credentialId);
  if (had) {
    logger.debug(
      { component: "oauth-token-manager", event: "token_invalidated", credentialId },
      "OAuth token manually invalidated",
    );
  }
}

/** Current cached token count — used by `cache/health.ts`. */
export function _oauthTokenCacheSize(): number {
  return tokenCache.size;
}

// ─── Internals ─────────────────────────────────────────────────────────

async function fetchAndCacheToken(credentialId: string): Promise<CachedToken> {
  const fields: OauthClientFields = await loadOauthFields(credentialId);

  const body: URLSearchParams = new URLSearchParams({
    grant_type: "client_credentials",
  });
  if (fields.scope !== undefined && fields.scope.length > 0) {
    body.set("scope", fields.scope);
  }

  // RFC 6749 §2.3.1 client_secret_basic — universally supported and
  // keeps the secret out of the request body.
  const basicAuth: string = Buffer.from(
    `${fields.clientId}:${fields.clientSecret}`,
    "utf8",
  ).toString("base64");

  let res: Response;
  try {
    res = await fetch(fields.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    const message: string = err instanceof Error ? err.message : String(err);
    throw new Error(`OAuth token endpoint unreachable (${fields.tokenUrl}): ${message}`);
  }

  if (!res.ok) {
    // Read up to a short slice so we don't dump megabytes of HTML
    // error pages into the logs.
    const errBody: string = await res.text().catch(() => "");
    throw new Error(
      `OAuth token endpoint returned ${res.status} ${res.statusText}: ${errBody.slice(0, 200)}`,
    );
  }

  let json: TokenEndpointResponse;
  try {
    json = (await res.json()) as TokenEndpointResponse;
  } catch (err) {
    const message: string = err instanceof Error ? err.message : String(err);
    throw new Error(`OAuth token endpoint returned non-JSON body: ${message}`);
  }

  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("OAuth token endpoint response missing access_token");
  }

  const expiresInSec: number =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? json.expires_in
      : DEFAULT_EXPIRES_IN_S;

  const entry: CachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };

  tokenCache.set(credentialId, entry);

  logger.debug(
    {
      component: "oauth-token-manager",
      event: "token_obtained",
      credentialId,
      expiresInSec,
      scope: json.scope ?? null,
    },
    "OAuth access token obtained",
  );

  return entry;
}

async function loadOauthFields(credentialId: string): Promise<OauthClientFields> {
  const cfg = await getCredentialFieldsById(credentialId);
  if (cfg === null) {
    throw new Error(`OAuth credential ${credentialId} not found or disabled`);
  }
  const parsed = OauthClientFieldsSchema.safeParse(cfg.fields);
  if (!parsed.success) {
    const firstIssue: string = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `OAuth credential ${credentialId} has invalid payload (${firstIssue})`,
    );
  }
  return parsed.data;
}
