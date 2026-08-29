import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource, ResourceWithRBAC, canDeleteResource } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoCaseTable, WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { eq } from "drizzle-orm";

const ROUTE = "/api/web-auto-cases/[id]";

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    assertions: z.array(z.unknown()).optional(),
    enabled: z.boolean().optional(),
    suiteId: z.string().uuid().optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, session, params }) => {
    const { id } = await params;
    const caseId = Number(id);
    if (!Number.isSafeInteger(caseId) || caseId <= 0) {
      throw new ApiError("VALIDATION_FAILED", 400, "Invalid case ID format.");
    }
    const body = await parseBody(req, updateSchema);

    // Get case and its parent suite to check permissions
    const [existing] = await db
      .select({
        suiteVisibility: WebAutoSuiteTable.visibility,
        suiteCreatedBy: WebAutoSuiteTable.createdBy,
      })
      .from(WebAutoCaseTable)
      .innerJoin(WebAutoSuiteTable, eq(WebAutoSuiteTable.id, WebAutoCaseTable.suiteId))
      .where(eq(WebAutoCaseTable.id, caseId));

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Case not found");
    }

    // Checking permissions against the parent suite
    if (!canEditResource({ visibility: existing.suiteVisibility, createdBy: existing.suiteCreatedBy } as unknown as ResourceWithRBAC, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You do not have permission to edit this case.",
      );
    }

    const [updated] = await db
      .update(WebAutoCaseTable)
      .set({
        ...body,
        updatedBy: session.user.id,
        updatedAt: new Date(),
      })
      .where(eq(WebAutoCaseTable.id, caseId))
      .returning();

    return NextResponse.json(updated);
  },
);

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ session, params }) => {
    const { id } = await params;
    const caseId = Number(id);
    if (!Number.isSafeInteger(caseId) || caseId <= 0) {
      throw new ApiError("VALIDATION_FAILED", 400, "Invalid case ID format.");
    }

    const [existing] = await db
      .select({
        suiteVisibility: WebAutoSuiteTable.visibility,
        suiteCreatedBy: WebAutoSuiteTable.createdBy,
      })
      .from(WebAutoCaseTable)
      .innerJoin(WebAutoSuiteTable, eq(WebAutoSuiteTable.id, WebAutoCaseTable.suiteId))
      .where(eq(WebAutoCaseTable.id, caseId));

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Case not found");
    }

    if (!canDeleteResource({ visibility: existing.suiteVisibility, createdBy: existing.suiteCreatedBy } as unknown as ResourceWithRBAC, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You do not have permission to delete this case.",
      );
    }

    const [deleted] = await db
      .delete(WebAutoCaseTable)
      .where(eq(WebAutoCaseTable.id, caseId))
      .returning({ id: WebAutoCaseTable.id });

    return NextResponse.json(deleted);
  },
);
