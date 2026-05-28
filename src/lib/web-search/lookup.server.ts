/**
 * Server-only resolver: pick a usable web-search credential.
 *
 * Strategy (V1): single global tool, no per-agent binding. Pick the
 * first enabled `serviceType="search"` credential whose provider is
 * registered in `WEB_SEARCH_PROVIDERS`, broken by
 * `PROVIDER_PRIORITY`, then by `createdAt` desc within a provider.
 *
 * Not cached on its own — `getCredentialFieldsById` already caches
 * decrypted payloads with a 10-min TTL; the outer SELECT is one
 * indexed read per `web_search` call and that frequency is several
 * orders of magnitude below chat turns.
 */

import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";
import { decrypt } from "@/lib/credentials/crypto";
import { logger } from "@/lib/observability/logger";

import { PROVIDER_PRIORITY } from "./registry.server";
import { isWebSearchProvider, type WebSearchProviderId } from "./types";

export interface ResolvedSearchCredential {
  /** uuid of the chosen credential — surfaced in logs / run forensics. */
  credentialId: string;
  provider: WebSearchProviderId;
  apiKey: string;
  /** Override base URL the user set on the credential row; `null`
   *  means "use the provider's default endpoint". */
  restUrl: string | null;
}

export type SearchCredentialResolution =
  | { ok: true; resolved: ResolvedSearchCredential }
  | {
      ok: false;
      error: "NO_PROVIDER" | "AUTH_MISSING";
      message: string;
    };

/**
 * @returns A usable credential, or a typed error the tool surfaces
 * verbatim to the LLM as `{ok:false,error,message}`.
 */
export async function resolveSearchCredential(): Promise<SearchCredentialResolution> {
  const rows = await db
    .select({
      id: CredentialTable.id,
      provider: CredentialTable.provider,
      restUrl: CredentialTable.restUrl,
      encryptedPayload: CredentialTable.encryptedPayload,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "search"),
        eq(CredentialTable.enabled, true),
        inArray(CredentialTable.provider, [...PROVIDER_PRIORITY]),
      ),
    )
    .orderBy(desc(CredentialTable.createdAt));

  if (rows.length === 0) {
    return {
      ok: false,
      error: "NO_PROVIDER",
      message:
        "No enabled web-search credential found. Ask an admin to add " +
        "one under Credentials → Search (Exa, Tavily, or Brave).",
    };
  }

  // Walk PROVIDER_PRIORITY in order; first row whose provider matches
  // AND whose payload decrypts to a non-empty key wins. A decryption
  // failure or empty key on the top-priority provider falls through
  // to the next provider rather than failing the whole call — the
  // operator may have a working Brave credential even if the Exa key
  // got corrupted.
  for (const id of PROVIDER_PRIORITY) {
    const row = rows.find((r) => r.provider === id);
    if (!row) continue;
    const apiKey = extractApiKey(row.encryptedPayload, row.id, id);
    if (!apiKey) continue;
    return {
      ok: true,
      resolved: {
        credentialId: row.id,
        provider: id,
        apiKey,
        restUrl: row.restUrl ?? null,
      },
    };
  }

  return {
    ok: false,
    error: "AUTH_MISSING",
    message:
      "Found a search credential but could not decrypt its API key. " +
      "Check the credential's payload (admin → Credentials).",
  };
}

/**
 * Decrypts the credential payload and pulls out the API key. Returns
 * null on any decryption / shape failure — failures are logged at
 * `warn` so admins can see them in pino output, but the caller
 * decides how to surface the user-facing error.
 *
 * SECURITY: the decrypted key is in memory only inside this function
 * and the returned string. No logging of the key itself.
 */
function extractApiKey(
  encryptedPayload: string,
  credentialId: string,
  provider: WebSearchProviderId,
): string | null {
  let payload: Record<string, unknown>;
  try {
    payload = decrypt(encryptedPayload) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      {
        component: "web-search-lookup",
        event: "decrypt_failed",
        credentialId,
        provider,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      "search credential decryption failed",
    );
    return null;
  }

  // Same precedence as `extractTokenFromEncryptedPayload` in
  // credentials/lookup.ts — accepts both `api_key` and `bearer_token`
  // credential shapes without the call site caring.
  const raw = payload.token ?? payload.key ?? payload.password;
  if (typeof raw !== "string" || raw.length === 0) {
    logger.warn(
      {
        component: "web-search-lookup",
        event: "missing_api_key",
        credentialId,
        provider,
      },
      "search credential payload had no usable api key field",
    );
    return null;
  }
  return raw;
}

// Re-export the type predicate so callers don't pay an extra import.
export { isWebSearchProvider };
