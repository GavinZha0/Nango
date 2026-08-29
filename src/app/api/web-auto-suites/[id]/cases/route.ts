import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";

import { canViewResource, canEditResource, type ResourceWithRBAC } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoSuiteTable, WebAutoCaseTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";

const ROUTE = "/api/web-auto-suites/[id]/cases";

const suiteIdSchema = z.string().uuid();

// GET /api/web-auto-suites/[id]/cases
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const parseResult = suiteIdSchema.safeParse(params.id);
    if (!parseResult.success) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found.");
    }
    const suiteId = parseResult.data;

    // Ensure user has access to the suite
    const [suite] = await db
      .select({
        visibility: WebAutoSuiteTable.visibility,
        createdBy: WebAutoSuiteTable.createdBy,
      })
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, suiteId));

    if (!suite || !canViewResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found or access denied.");
    }

    const rows = await db
      .select({
        id: WebAutoCaseTable.id,
        suiteId: WebAutoCaseTable.suiteId,
        name: WebAutoCaseTable.name,
        input: WebAutoCaseTable.input,
        assertions: WebAutoCaseTable.assertions,
        enabled: WebAutoCaseTable.enabled,
        createdBy: WebAutoCaseTable.createdBy,
        updatedBy: WebAutoCaseTable.updatedBy,
        createdAt: WebAutoCaseTable.createdAt,
        updatedAt: WebAutoCaseTable.updatedAt,
      })
      .from(WebAutoCaseTable)
      .where(eq(WebAutoCaseTable.suiteId, suiteId))
      .orderBy(asc(WebAutoCaseTable.name));

    return NextResponse.json(rows);
  },
);

// POST /api/web-auto-suites/[id]/cases
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    input: z.record(z.string(), z.unknown()).optional(),
    assertions: z.array(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const parseResult = suiteIdSchema.safeParse(params.id);
    if (!parseResult.success) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found.");
    }
    const suiteId = parseResult.data;

    const body = await parseBody(req, createSchema);

    // Ensure user can edit the suite
    const [suite] = await db
      .select({
        visibility: WebAutoSuiteTable.visibility,
        createdBy: WebAutoSuiteTable.createdBy,
      })
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, suiteId));

    if (!suite) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found.");
    }

    if (!canEditResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You do not have permission to add cases to this suite.",
      );
    }

    try {
      const [row] = await db
        .insert(WebAutoCaseTable)
        .values({
          suiteId,
          name: body.name,
          input: body.input ?? {},
          assertions: body.assertions ?? [],
          enabled: body.enabled ?? true,
          createdBy: session.user.id,
          updatedBy: session.user.id,
        })
        .returning();

      return NextResponse.json(row, { status: 201 });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(
          "CONFLICT",
          409,
          `A case named "${body.name}" already exists in this suite.`,
        );
      }
      throw err;
    }
  },
);
