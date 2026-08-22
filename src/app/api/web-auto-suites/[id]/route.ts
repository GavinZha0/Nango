import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource, ResourceWithRBAC, canDeleteResource, canViewResource } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { eq, sql } from "drizzle-orm";

const ROUTE = "/api/web-auto-suites/[id]";

// GET /api/web-auto-suites/[id]
export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = await params;
    const [suite] = await db
      .select()
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, id));

    if (!suite || !canViewResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found or access denied.");
    }

    return NextResponse.json(suite);
  },
);

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    parentId: z.string().uuid().optional().nullable(),
    variables: z.record(z.string(), z.unknown()).optional(),
    visibility: z.enum(["private", "public"]).optional(),
    enabled: z.boolean().optional(),
    timeoutSec: z.number().int().min(10).max(7200).optional(),
    evaluatorAgentId: z.string().uuid().optional().nullable(),
    mcpServerId: z.string().uuid().optional().nullable(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, session, params }) => {
    const { id } = await params;
    const body = await parseBody(req, updateSchema);

    const [suite] = await db
      .select({
        visibility: WebAutoSuiteTable.visibility,
        createdBy: WebAutoSuiteTable.createdBy,
      })
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, id));

    if (!suite) {
      throw new ApiError("NOT_FOUND", 404, "Suite not found");
    }

    if (!canEditResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You do not have permission to edit this suite.",
      );
    }

    // Enforce 2-level nesting if parentId is being updated
    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === id) {
        throw new ApiError("VALIDATION_FAILED", 400, "A suite cannot be its own parent.");
      }

      const [parentSuite] = await db
        .select({ parentId: WebAutoSuiteTable.parentId })
        .from(WebAutoSuiteTable)
        .where(eq(WebAutoSuiteTable.id, body.parentId));

      if (!parentSuite) {
        throw new ApiError("NOT_FOUND", 404, "Parent group not found.");
      }
      if (parentSuite.parentId !== null) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          "Maximum nesting level reached. Suites can only belong to top-level groups.",
        );
      }
      
      // Also prevent moving a group (that has children) to become a child of another group.
      // Easiest check: if this suite currently has children, it cannot have a parentId set.
      const [childCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(WebAutoSuiteTable)
        .where(eq(WebAutoSuiteTable.parentId, id));
        
      if (childCount && childCount.count > 0) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          "Cannot move a group that contains suites. Remove its suites first.",
        );
      }
    }

    const [updated] = await db
      .update(WebAutoSuiteTable)
      .set({
        ...body,
        updatedBy: session.user.id,
        updatedAt: new Date(),
      })
      .where(eq(WebAutoSuiteTable.id, id))
      .returning();

    return NextResponse.json(updated);
  },
);

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ session, params }) => {
    const { id } = await params;

    const [suite] = await db
      .select({
        visibility: WebAutoSuiteTable.visibility,
        createdBy: WebAutoSuiteTable.createdBy,
      })
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, id));

    if (!suite) {
      throw new ApiError("NOT_FOUND", 404, "Suite not found");
    }

    if (!canDeleteResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You do not have permission to delete this suite.",
      );
    }

    const [deleted] = await db
      .delete(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, id))
      .returning({ id: WebAutoSuiteTable.id });

    return NextResponse.json(deleted);
  },
);
