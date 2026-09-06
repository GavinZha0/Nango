import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource, canViewResource, ResourceWithRBAC } from "@/lib/auth/permissions";
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
        suiteId: WebAutoCaseTable.suiteId,
        suiteVisibility: WebAutoSuiteTable.visibility,
        suiteCreatedBy: WebAutoSuiteTable.createdBy,
        suiteMcpServerId: WebAutoSuiteTable.mcpServerId,
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

    // CONTRACT: moving a case re-binds its execution context — validate the
    // target suite exactly like the verification module (existence, edit
    // permission, same Playwright server).
    if (body.suiteId !== undefined && body.suiteId !== existing.suiteId) {
      const [target] = await db
        .select({
          visibility: WebAutoSuiteTable.visibility,
          createdBy: WebAutoSuiteTable.createdBy,
          mcpServerId: WebAutoSuiteTable.mcpServerId,
        })
        .from(WebAutoSuiteTable)
        .where(eq(WebAutoSuiteTable.id, body.suiteId))
        .limit(1);

      if (!target) {
        throw new ApiError("BAD_REQUEST", 400, "Target web auto suite not found.");
      }

      if (!canEditResource(target as unknown as ResourceWithRBAC, session)) {
        throw new ApiError(
          "FORBIDDEN",
          403,
          "You cannot move cases to this target suite.",
        );
      }

      if (existing.suiteMcpServerId !== target.mcpServerId) {
        throw new ApiError(
          "BAD_REQUEST",
          400,
          "Cannot move case to a suite belonging to a different Playwright server.",
        );
      }
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
        caseCreatedBy: WebAutoCaseTable.createdBy,
        suiteVisibility: WebAutoSuiteTable.visibility,
        suiteCreatedBy: WebAutoSuiteTable.createdBy,
      })
      .from(WebAutoCaseTable)
      .innerJoin(WebAutoSuiteTable, eq(WebAutoSuiteTable.id, WebAutoCaseTable.suiteId))
      .where(eq(WebAutoCaseTable.id, caseId));

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Case not found");
    }

    // Opaque 404 first — private suite membership must not be discoverable.
    if (!canViewResource({ visibility: existing.suiteVisibility, createdBy: existing.suiteCreatedBy } as unknown as ResourceWithRBAC, session)) {
      throw new ApiError("NOT_FOUND", 404, "Case not found");
    }

    // CONTRACT (unified delete rule across all three test modules):
    // case author OR suite author OR admin.
    const isAdminUser = session.user.role === "admin";
    const isCaseAuthor = existing.caseCreatedBy === session.user.id;
    const isSuiteAuthor = existing.suiteCreatedBy === session.user.id;
    if (!isAdminUser && !isCaseAuthor && !isSuiteAuthor) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the case creator, the suite creator, or an admin can delete this case.",
      );
    }

    const [deleted] = await db
      .delete(WebAutoCaseTable)
      .where(eq(WebAutoCaseTable.id, caseId))
      .returning({ id: WebAutoCaseTable.id });

    return NextResponse.json(deleted);
  },
);
