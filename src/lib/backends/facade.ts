/**
 * Backend platform façade — generic fan-out + credential-name tagging.
 * All backend-specific switches live inside the per-platform adapters
 * under `./providers/`. Onboarding: `docs/backend-integration.md` §10.
 */

import { ADAPTERS } from "./registry";
import { isSupportedBackend } from "./types";
import type {
  BackendCapabilities,
  EntityDescriptor,
  EntityKind,
  FetchResult,
  BackendId,
} from "./types";

// Re-exported types

export type { FetchResult, BackendId } from "./types";
export { agentKey } from "./types";
export type {
  EntityDescriptor,
  EntityKind,
  BackendCapabilities,
} from "./types";

// Credential descriptors

export interface BackendCredentialInfo {
  credentialId: string;
  name: string;
  provider: BackendId;
}

/** 
 * Silently drops unknown providers — they only become known
 * after their adapter is registered. 
 */
export function toBackendCredentials(
  configs: { id: string; name: string; provider: string | null }[],
): BackendCredentialInfo[] {
  return configs
    .filter((c): c is { id: string; name: string; provider: BackendId } =>
      isSupportedBackend(c.provider),
    )
    .map((c) => ({ credentialId: c.id, name: c.name, provider: c.provider }));
}

// Resource discovery

export interface GetEntitiesOptions {
  /** Omit to return every kind the matching credentials advertise. */
  kinds?: readonly EntityKind[];
  /** Bypass the per-credential entity-table cache (manual refresh). */
  force?: boolean;
}

/** CONTRACT: per-credential errors so a single bad backend doesn't
 *  blank the others. */
interface EntitiesResponse {
  entities: EntityDescriptor[];
  errors: { credentialId: string; message: string }[];
}

/**
 * Fetch every entity from the given credentials via `GET /api/entities`.
 * Control-plane entry point — the server resolves each credential
 * through `EntityCatalog` (10-min TTL + singleflight) and returns
 * descriptors with `credentialName` already attached. Per-credential
 * errors are surfaced without aborting the whole call.
 *
 * Note: chat dispatch (`/api/copilotkit`) DOES read EntityCatalog —
 * exactly once per request to resolve `entityKind` server-side from
 * `(credentialId, agentId)`. The cache is warmed by the agent picker
 * on UI mount, so hits are sub-ms; the dispatch path never trusts a
 * client-supplied kind. Supervisor and scheduler resolve kind through
 * their own paths (precomputed catalog / `schedule.entity_kind`).
 * See `docs/orchestrator.md` "Custom HTTP Headers" and
 * `docs/backend-integration.md` §3.
 *
 * Errors are joined into one string for `FetchResult` shape
 * compatibility; callers needing per-credential attribution can hit
 * `/api/entities` directly.
 */
export async function getEntities(
  credentials: BackendCredentialInfo[],
  options?: GetEntitiesOptions,
): Promise<FetchResult<EntityDescriptor[]>> {
  if (credentials.length === 0) {
    return { data: [], error: null };
  }

  const params = new URLSearchParams();
  params.set("credentialIds", credentials.map((c) => c.credentialId).join(","));
  if (options?.kinds && options.kinds.length > 0) {
    params.set("kinds", options.kinds.join(","));
  }
  if (options?.force) {
    params.set("force", "true");
  }

  try {
    const res = await fetch(`/api/entities?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return { data: null, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as EntitiesResponse;

    if (body.errors.length > 0 && body.entities.length === 0) {
      return {
        data: null,
        error: body.errors
          .map((e) => `[${e.credentialId}] ${e.message}`)
          .join("; "),
      };
    }
    return { data: body.entities, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: message };
  }
}

/** Convenience wrapper for a single kind. */
export function getEntitiesOfKind(
  credentials: BackendCredentialInfo[],
  kind: EntityKind,
): Promise<FetchResult<EntityDescriptor[]>> {
  return getEntities(credentials, { kinds: [kind] });
}

// Capability helpers

/** CONTRACT: returns null for unknown providers so callers can render safely. */
export function getCapabilities(
  provider: string | undefined | null,
): BackendCapabilities | null {
  return isSupportedBackend(provider) ? ADAPTERS[provider].capabilities : null;
}

/** True when any credential's adapter can produce `kind`. UI uses this
 *  to decide whether to render a "Teams" / "Workflows" section
 *  without a list call first. */
export function hasEntityKind(
  credentials: BackendCredentialInfo[],
  kind: EntityKind,
): boolean {
  return credentials.some((c) =>
    ADAPTERS[c.provider].capabilities.entityKinds.includes(kind),
  );
}
