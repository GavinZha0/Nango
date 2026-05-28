/**
 * OAuth 2.0 Client Credentials Grant — access token manager.
 *
 * Manages the lifecycle of access tokens obtained from a `tokenUrl`
 * using a stored `oauth_client` credential row `{clientId, clientSecret,
 * tokenUrl, scope?}`. Behavior:
 *
 *   - **Lazy refresh** (no background timer): tokens are fetched on
 *     first call and refreshed automatically when the cached one is
 *     within `REFRESH_SKEW_MS` of its expiry. No `setInterval` to
 *     leak through Next.js HMR, no traffic to the IdP for unused
 *     credentials.
 *
 *   - **Concurrency dedup**: if N callers ask for the same credential's
 *     token while the token endpoint is being hit, they all await the
 *     same in-flight Promise — exactly ONE network round-trip per
 *     refresh cycle. Avoids thundering-herd on cold start.
 *
 *   - **Cache invalidation hook-up**: subscribes to
 *     `onCredentialCacheInvalidated` so an admin's edit to the
 *     credential row (rotated secret, changed tokenUrl, …) takes
 *     effect on the very next call without restarting the process.
 *
 *   - **Three-tier public API**:
 *       1. `getOAuthAccessToken(id)`           — raw token string
 *       2. `getOAuthAuthorizationHeader(id)`   — `"Bearer <token>"`
 *       3. `withOAuth(id, init)`               — RequestInit wrapper
 *     Most callers want tier 3. Tier 1 is for non-Bearer schemes
 *     (DPoP, custom headers).
 *
 *   - **Manual eviction**: `invalidateOAuthToken(id)` lets a caller
 *     drop a token after receiving a 401 from the downstream API
 *     (token revoked / expired earlier than `expires_in` promised);
 *     next call re-fetches.
 *
 * Out of scope (intentionally):
 *   - `refresh_token`: RFC 6749 §4.4.3 forbids refresh tokens for the
 *     Client Credentials grant — every refresh just re-runs the
 *     `client_credentials` flow with the stored secret.
 *   - mTLS / PEM client certificates: handle that at the TLS layer
 *     (NODE_EXTRA_CA_CERTS for trusting a self-signed CA; a custom
 *     `https.Agent` if per-credential PEM is ever needed).
 *
 * @see docs/cache.md §2.1 (cache TTL philosophy)
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
// HMR-survival via globalThis: oauth tokens are expensive to mint
// (round trip to the IdP), and the in-flight Map is the dedupe gate
// against thundering-herd. A dev save would otherwise re-mint every
// token on the next API call. The `credentialSubscribed` flag also
// has to live here so re-evaluation doesn't push a second subscription
// into the (pinned) credential-cache invalidation list.

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

// Subscribe exactly once across all HMR re-evaluations. When the
// credential cache is cleared (admin edited a credential row), drop
// all our tokens too so the next call picks up rotated secrets.
//
// Note: this is a coarse "clear-all" today. If precision becomes a
// problem (many OAuth creds, frequent edits to unrelated rows) we can
// add a per-id invalidation channel to lookup.ts.
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
 * Get a valid OAuth 2.0 access token for the given credential.
 *
 * Behavior:
 *   - Returns the cached token if it has more than `REFRESH_SKEW_MS`
 *     of remaining lifetime.
 *   - Otherwise hits the token endpoint (deduped across concurrent
 *     callers) and caches the result.
 *
 * Throws on missing credential, decryption failure, malformed payload,
 * or non-2xx token endpoint response.
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

/**
 * Convenience helper — returns `"Bearer <token>"` for direct use as
 * an HTTP `Authorization` header value. 99% of OAuth callers want
 * this; tier-1 `getOAuthAccessToken` is for DPoP / custom schemes.
 */
export async function getOAuthAuthorizationHeader(credentialId: string): Promise<string> {
  const token: string = await getOAuthAccessToken(credentialId);
  return `Bearer ${token}`;
}

/**
 * Highest-level convenience helper — clones a fetch `RequestInit`
 * with an OAuth Bearer `Authorization` header merged in. Lets callers
 * write `fetch(url, await withOAuth(id, { method: "POST" }))` without
 * thinking about token lifecycle.
 *
 * Existing `Authorization` in `init.headers` is OVERWRITTEN — the
 * whole point of this helper is to provide auth, so we treat caller
 * intent as "yes, please replace whatever I had with the OAuth one".
 */
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

/**
 * Force-drop the cached token. Callers should invoke this when the
 * downstream API returns 401 — the IdP may have revoked the token
 * earlier than its advertised `expires_in`, and the next call should
 * re-fetch from the token endpoint.
 */
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

  // Per RFC 6749 §2.3.1, client_secret_basic (HTTP Basic with
  // clientId:clientSecret) is the recommended method. Some IdPs also
  // accept body-style (client_secret_post); we use Basic because it's
  // universally supported and keeps the secret out of the request body.
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
