import "server-only";

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  CredentialTable,
  ScheduleTable,
} from "@/lib/db/schema";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import {
  registerSchedule,
  validateTriggerSpec,
} from "@/lib/runner/scheduler";
import { toScheduleResponse } from "@/lib/runner/schedule-dto";
import { validateScheduleTarget } from "@/lib/runner/schedule-validation";
import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";

/**
 * GET  /api/schedules — caller's schedules, newest first.
 */

const ROUTE = "/api/schedules";

export const GET = withSession(ROUTE, async ({ session }) => {
  const rows = await db
    .select()
    .from(ScheduleTable)
    .where(eq(ScheduleTable.ownerId, session.user.id))
    .orderBy(desc(ScheduleTable.createdAt));
  return NextResponse.json(rows.map(toScheduleResponse));
});

const intervalUnitSchema = z.enum([
  "minute",
  "hour",
  "day",
  "week",
  "month",
]);

const createBodySchema = z.object({
  /** Either a built-in agent UUID (no credentialId) or a backend
   *  entity id paired with credentialId. The route validates that
   *  the caller can actually reach the named target before persisting. */
  entityId: z.string().min(1),
  credentialId: z.string().uuid().optional(),
  /** Discriminator for the upstream endpoint family. Snapshotted at
   *  create time so the scheduler can fire without an entity-catalog
   *  round-trip. Always "agent" for built-in entities. */
  entityKind: z.enum(["agent", "team", "workflow"]),
  /** Display label captured at create time so renames don't break
   *  the panel. Required so the UI never has to fall back to opaque
   *  ids. */
  sourceLabel: z.string().min(1),
  task: z.string().min(1),
  /** ISO datetime (UTC). The first scheduled fire. */
  startAt: z.string().datetime(),
  /** ISO datetime (UTC). Optional upper bound — past it, the
   *  schedule auto-disables. Requires `intervalValue` / `intervalUnit`. */
  endAt: z.string().datetime().nullable().optional(),
  /** Positive integer; null for a one-shot schedule. */
  intervalValue: z.number().int().positive().nullable().optional(),
  intervalUnit: intervalUnitSchema.nullable().optional(),
  timezone: z.string().min(1).default("UTC"),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Production deps for `validateScheduleTarget`. Pure DB / catalog
 * lookups; the validator owns the policy. SECURITY: this is what
 * enforces the "scheduler kind is snapshotted from the catalog at
 * creation" half of the contract for the editor / REST entry point —
 * see `docs/backend-integration.md` §6. The supervisor
 * `create_schedule` tool reads kind directly from its catalog entry
 * and bypasses this path by construction.
 */
const scheduleValidationDeps = {
  async getEnabledCredential(credentialId: string) {
    const [cred] = await db
      .select({ enabled: CredentialTable.enabled })
      .from(CredentialTable)
      .where(eq(CredentialTable.id, credentialId))
      .limit(1);
    return cred ?? null;
  },
  listCatalog: EntityCatalog.list,
  isBuiltinVisibleTo: (agentId: string, userId: string) =>
    isAgentVisibleTo(agentId, userId),
};

export const POST = withSession(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createBodySchema);

  const startAt = new Date(body.startAt);
  const endAt = body.endAt ? new Date(body.endAt) : null;
  const intervalValue = body.intervalValue ?? null;
  const intervalUnit = body.intervalUnit ?? null;

  const triggerValidation = validateTriggerSpec({
    startAt,
    endAt,
    intervalValue,
    intervalUnit,
    timezone: body.timezone,
  });
  if (!triggerValidation.ok) {
    throw new ApiError("BAD_REQUEST", 400, triggerValidation.error);
  }

  const targetValidation = await validateScheduleTarget({
    userId: session.user.id,
    entityId: body.entityId,
    entityKind: body.entityKind,
    credentialId: body.credentialId,
    deps: scheduleValidationDeps,
  });
  if (!targetValidation.ok) {
    const code =
      targetValidation.status === 404
        ? "NOT_FOUND"
        : targetValidation.status === 403
          ? "FORBIDDEN"
          : "BAD_REQUEST";
    throw new ApiError(code, targetValidation.status, targetValidation.error);
  }

  const [row] = await db
    .insert(ScheduleTable)
    .values({
      ownerId: session.user.id,
      createdBy: session.user.id,
      entityId: body.entityId,
      entityKind: body.entityKind,
      credentialId: body.credentialId ?? null,
      sourceLabel: body.sourceLabel,
      name: body.name?.trim() || null,
      task: body.task,
      startAt,
      endAt,
      intervalValue,
      intervalUnit,
      timezone: body.timezone,
      enabled: body.enabled ?? true,
    })
    .returning();
  registerSchedule(row);
  return NextResponse.json(toScheduleResponse(row), { status: 201 });
});
