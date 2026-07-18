/**
 * Backend platform façade — generic fan-out + credential-name tagging.
 * See docs/backend-integration.md.
 */

import { ADAPTERS } from "./registry";
import { isSupportedBackend } from "./types";
import type {
  BackendCapabilities,
  EntityDescriptor,
  EntityFetchError,
  EntityKind,
  BackendId,
} from "./types";

// Re-exported types

export type { FetchResult, BackendId } from "./types";
export { agentKey } from "./types";
export type {
  EntityDescriptor,
  EntityFetchError,
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

export interface CredentialEntityStatus {
  credentialId: string;
  name: string;
  ok: boolean;
  errors: EntityFetchError[];
}

/** CONTRACT: per-credential errors so a single bad backend doesn't
 *  blank the others. */
interface EntitiesResponse {
  entities: EntityDescriptor[];
  credentials: CredentialEntityStatus[];
}

export interface GetEntitiesResult {
  data: EntityDescriptor[] | null;
  error: string | null;
  credentials: CredentialEntityStatus[];
}


export async function getEntities(
  credentials: readonly { credentialId: string }[],
  options?: GetEntitiesOptions,
): Promise<GetEntitiesResult> {
  if (credentials.length === 0) {
    return { data: [], error: null, credentials: [] };
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
      return { data: null, error: `HTTP ${res.status} ${res.statusText}`, credentials: [] };
    }
    const body = (await res.json()) as EntitiesResponse;

    const failed = body.credentials.filter((c) => !c.ok);
    const error = failed.length > 0 
      ? failed.map((c) => `[${c.name}] ${c.errors.map((e) => e.message).join(", ") || "unavailable"}`).join("; ") 
      : null;
    return { data: body.entities, error, credentials: body.credentials };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: message, credentials: [] };
  }
}

/** Convenience wrapper for a single kind. */
export function getEntitiesOfKind(
  credentials: readonly { credentialId: string }[],
  kind: EntityKind,
): Promise<GetEntitiesResult> {
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
