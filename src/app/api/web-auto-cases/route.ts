import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canViewResource, ResourceWithRBAC, canEditResource } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoSuiteTable, WebAutoCaseTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { asc, eq } from "drizzle-orm";

const ROUTE = "/api/web-auto-cases";

// GET /api/web-auto-cases?suiteId=xxx
export const GET = withSession(ROUTE, async ({ req, session }) => {
  const suiteId = new URL(req.url).searchParams.get("suiteId");
  if (!suiteId) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "Query param `suiteId` is required.",
    );
  }

  // Ensure user has access to the suite
  const [suite] = await db
    .select({
      visibility: WebAutoSuiteTable.visibility,
      createdBy: WebAutoSuiteTable.createdBy,
    })
    .from(WebAutoSuiteTable)
    .where(eq(WebAutoSuiteTable.id, suiteId));

  if (!suite || !canViewResource(suite as unknown as ResourceWithRBAC, session)) {
    throw new ApiError("NOT_FOUND", 404, "Suite not found or access denied.");
  }

  const rows = await db
    .select({
      id: WebAutoCaseTable.id,
      suiteId: WebAutoCaseTable.suiteId,
      name: WebAutoCaseTable.name,
      description: WebAutoCaseTable.description,
      scriptContent: WebAutoCaseTable.scriptContent,
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
});

// POST /api/web-auto-cases
const createSchema = z
  .object({
    suiteId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    scriptContent: z.string().optional().nullable(),
    assertions: z.array(z.unknown()).optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  // Ensure user can edit the suite
  const [suite] = await db
    .select({
      visibility: WebAutoSuiteTable.visibility,
      createdBy: WebAutoSuiteTable.createdBy,
    })
    .from(WebAutoSuiteTable)
    .where(eq(WebAutoSuiteTable.id, body.suiteId));

  if (!suite || !canEditResource(suite as unknown as ResourceWithRBAC, session)) {
    throw new ApiError(
      "FORBIDDEN",
      403,
      "You do not have permission to add cases to this suite.",
    );
  }

  const [row] = await db
    .insert(WebAutoCaseTable)
    .values({
      suiteId: body.suiteId,
      name: body.name,
      description: body.description ?? null,
      scriptContent: body.scriptContent ?? null,
      assertions: body.assertions ?? [],
      createdBy: session.user.id,
      updatedBy: session.user.id,
    })
    .returning();

  return NextResponse.json(row, { status: 201 });
});
