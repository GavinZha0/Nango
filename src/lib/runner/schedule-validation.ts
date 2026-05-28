import "server-only";

import type { EntityDescriptor, EntityKind } from "@/lib/backends/types";

/**
 * Validate that a schedule's `(credentialId, entityId, entityKind)` is
 */
export interface ScheduleTargetValidationDeps {
  /** Look up an enabled credential row. Returns null when the row is
   *  missing or `enabled = false`. */
  getEnabledCredential: (credentialId: string) => Promise<{
    enabled: boolean;
  } | null>;
  /** Fetch the credential's full entity table. May return null when
   *  the credential disappeared between the two lookups; the
   *  validator treats that as "not found in catalog". */
  listCatalog: (credentialId: string) => Promise<EntityDescriptor[] | null>;
  /** Built-in agent visibility predicate. */
  isBuiltinVisibleTo: (agentId: string, userId: string) => Promise<boolean>;
}

export interface ScheduleTargetValidationInput {
  userId: string;
  entityId: string;
  entityKind: EntityKind;
  credentialId?: string;
  deps: ScheduleTargetValidationDeps;
}

export type ScheduleTargetValidationResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function validateScheduleTarget(
  input: ScheduleTargetValidationInput,
): Promise<ScheduleTargetValidationResult> {
  const { userId, entityId, entityKind, credentialId, deps } = input;

  if (credentialId) {
    const cred = await deps.getEnabledCredential(credentialId);
    if (!cred || !cred.enabled) {
      return {
        ok: false,
        status: 404,
        error: "Backend credential not found or disabled.",
      };
    }
    const catalog = await deps.listCatalog(credentialId);
    const entry = catalog?.find((e) => e.id === entityId);
    if (!entry) {
      return {
        ok: false,
        status: 400,
        error:
          `Entity '${entityId}' is not present in the catalog of ` +
          `credential ${credentialId}.`,
      };
    }
    if (entry.kind !== entityKind) {
      return {
        ok: false,
        status: 400,
        error:
          `Entity '${entityId}' has kind '${entry.kind}' in the catalog; ` +
          `scheduled entityKind '${entityKind}' does not match.`,
      };
    }
    return { ok: true };
  }

  // Built-in dispatch — no credentialId, no catalog. The only valid
  // kind is "agent" (built-in entities are always agents) and the
  // caller must have visibility.
  if (entityKind !== "agent") {
    return {
      ok: false,
      status: 400,
      error: "Built-in entities must have entityKind = 'agent'.",
    };
  }
  const visible = await deps.isBuiltinVisibleTo(entityId, userId);
  if (!visible) {
    return {
      ok: false,
      status: 403,
      error: "Built-in agent is not visible.",
    };
  }
  return { ok: true };
}
