/**
 * Backend platform façade — generic fan-out + credential-name tagging.
 * See docs/backend-integration.md.
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

/** Silently drops unknown providers. */
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
 * Per-credential errors are joined into one string; callers needing
 * per-credential attribution can hit `/api/entities` directly.
 * See docs/backend-integration.md.
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

/** True when any credential's adapter can produce `kind`. */
export function hasEntityKind(
  credentials: BackendCredentialInfo[],
  kind: EntityKind,
): boolean {
  return credentials.some((c) =>
    ADAPTERS[c.provider].capabilities.entityKinds.includes(kind),
  );
}
