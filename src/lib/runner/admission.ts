/**
 * RunAdmission — the authorization invariant enforced at run creation.
 *
 * Called first thing in `recordRunStart`, so it CANNOT be bypassed,
 * reordered, or disabled (unlike the tunable safety middleware chain).
 * It answers "may this run start at all?" — identity / visibility /
 * binding — not "is this content safe?" (that is the guardrail layer).
 *
 * SECURITY (BUG-4): prevents a caller from forging an owner / entity /
 * parent-run tuple. Admin bypasses visibility. "Binding = authorization":
 * enforcement of the *specific* resources a run uses lives at the tool
 * boundary (BUG-1 data-source allowed-set / SSH allowedIds); this layer
 * asserts the entity itself is legitimate for the owner.
 *
 * See docs/architecture-improvements.md ("Authorization Model", RunAdmission).
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  EntityRunTable,
  UserTable,
  WorkflowTable,
  type EntityRunInitiator,
} from "@/lib/db/schema";
import type { EntityKind } from "@/lib/backends/types";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";
import { getAgentCredentialConfigById } from "@/lib/credentials/lookup";

/**
 * Subset of `RunRowSeed` that admission needs. `recordRunStart` passes
 * the full seed (structurally compatible). Kept local to avoid a value
 * import cycle with `event-store`.
 */
export interface AdmissionInput {
  ownerId: string;
  entityId: string;
  entityKind: EntityKind;
  entitySource: "backend" | "builtin";
  credentialId?: string;
  parentRunId?: string;
  initiator: EntityRunInitiator;
}

export type RunAdmissionCode =
  | "entity_forbidden"
  | "parent_run_not_found"
  | "parent_run_forbidden"
  | "credential_invalid";

export class RunAdmissionError extends Error {
  readonly code: RunAdmissionCode;
  constructor(code: RunAdmissionCode, message: string) {
    super(message);
    this.name = "RunAdmissionError";
    this.code = code;
  }
}

/**
 * System-initiated runs pick their entity programmatically (not a user
 * choosing a visible agent — e.g. the system evaluator agent), so
 * entity-visibility is exempt. They remain subject to the parent-run and
 * credential checks. (`verification` is not yet a run-creating initiator.)
 */
const SYSTEM_INITIATORS: ReadonlySet<EntityRunInitiator> = new Set([
  "evaluator",
  "system",
]);

async function isAdminUser(userId: string): Promise<boolean> {
  const rows = await db
    .select({ role: UserTable.role })
    .from(UserTable)
    .where(eq(UserTable.id, userId))
    .limit(1);
  return rows[0]?.role === "admin";
}

/**
 * Enforce the minimal RunAdmission invariant. Throws
 * {@link RunAdmissionError} when the run is not authorized. No-op for
 * the common legit flows (callers already pass a correct tuple); the
 * value is turning that convention into an unbypassable invariant and
 * re-verifying at fire time (schedules) / attach time (sub-runs).
 */
export async function admitRun(input: AdmissionInput): Promise<void> {
  const admin = await isAdminUser(input.ownerId);

  // 1. Entity visibility — skipped for admin and system-initiated runs.
  if (!admin && !SYSTEM_INITIATORS.has(input.initiator)) {
    await assertEntityVisible(input);
  }

  // 2. Parent-run ownership — a sub-run must attach to a run owned by
  //    the same principal (admin may cross owners).
  if (input.parentRunId) {
    const [row] = await db
      .select({ ownerId: EntityRunTable.ownerId })
      .from(EntityRunTable)
      .where(eq(EntityRunTable.id, input.parentRunId))
      .limit(1);
    if (!row) {
      throw new RunAdmissionError(
        "parent_run_not_found",
        `Parent run ${input.parentRunId} not found.`,
      );
    }
    if (!admin && row.ownerId !== input.ownerId) {
      throw new RunAdmissionError(
        "parent_run_forbidden",
        "Parent run belongs to a different owner.",
      );
    }
  }

  // 3. Credential must be enabled + an agent-type backend. Structural
  //    binding (credential == the entity's configured credential) is
  //    deferred to full RunAdmission (NEXT 1).
  if (input.credentialId) {
    const cfg = await getAgentCredentialConfigById(input.credentialId);
    if (!cfg) {
      throw new RunAdmissionError(
        "credential_invalid",
        "Credential is missing, disabled, or not an agent backend.",
      );
    }
  }
}

/**
 * Assert the run's entity is visible to `ownerId`. Errors say
 * "not found" (not "forbidden") so we never leak the existence of
 * another owner's private entity.
 */
async function assertEntityVisible(input: AdmissionInput): Promise<void> {
  // Built-in agent — canonical helper (admin-aware; public | owned).
  if (input.entitySource === "builtin" && input.entityKind === "agent") {
    if (!(await isAgentVisibleTo(input.entityId, input.ownerId))) {
      throw new RunAdmissionError(
        "entity_forbidden",
        `Agent ${input.entityId} not found.`,
      );
    }
    return;
  }

  // Workflow — public | owned (admin already handled above).
  if (input.entityKind === "workflow") {
    const [row] = await db
      .select({
        visibility: WorkflowTable.visibility,
        createdBy: WorkflowTable.createdBy,
      })
      .from(WorkflowTable)
      .where(eq(WorkflowTable.id, input.entityId))
      .limit(1);
    if (
      !row ||
      !(row.visibility === "public" || row.createdBy === input.ownerId)
    ) {
      throw new RunAdmissionError(
        "entity_forbidden",
        `Workflow ${input.entityId} not found.`,
      );
    }
    return;
  }

  // Backend agent — no per-user visibility model; access is governed by
  // the admin-managed credential, validated in the credential step.
  if (input.entitySource === "backend") {
    return;
  }

  // No other kind/source has a run-creation path today; allow-through
  // with an explicit branch to add when one appears.
}
