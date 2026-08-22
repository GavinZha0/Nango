import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { visibilitySql } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { asc, eq, sql } from "drizzle-orm";

const ROUTE = "/api/web-auto-suites";

// GET /api/web-auto-suites
// Returns visible web auto suites and folders.

export const GET = withEditor(ROUTE, async ({ session }) => {
  const rows = await db
    .select({
      id: WebAutoSuiteTable.id,
      parentId: WebAutoSuiteTable.parentId,
      name: WebAutoSuiteTable.name,
      description: WebAutoSuiteTable.description,
      variables: WebAutoSuiteTable.variables,
      enabled: WebAutoSuiteTable.enabled,
      visibility: WebAutoSuiteTable.visibility,
      timeoutSec: WebAutoSuiteTable.timeoutSec,
      evaluatorAgentId: WebAutoSuiteTable.evaluatorAgentId,
      mcpServerId: WebAutoSuiteTable.mcpServerId,
      createdBy: WebAutoSuiteTable.createdBy,
      updatedBy: WebAutoSuiteTable.updatedBy,
      createdAt: WebAutoSuiteTable.createdAt,
      updatedAt: WebAutoSuiteTable.updatedAt,
      caseCount: sql<number>`(
        select count(*)::int from "web_auto_case"
        where "web_auto_case"."suite_id" = "web_auto_suite"."id"
      )`,
    })
    .from(WebAutoSuiteTable)
    .where(
      visibilitySql(
        session,
        WebAutoSuiteTable.visibility,
        WebAutoSuiteTable.createdBy,
      ),
    )
    .orderBy(asc(WebAutoSuiteTable.name));

  return NextResponse.json(rows);
});

// POST /api/web-auto-suites
// Create a new suite or folder. Editor+ only.

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
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

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  // Enforce 2-level nesting: A suite's parent must be a top-level group (parentId is null)
  if (body.parentId) {
    if (!body.mcpServerId) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        "Playwright MCP server is required for a Web Auto suite.",
      );
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
  }

  const [row] = await db
    .insert(WebAutoSuiteTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      parentId: body.parentId ?? null,
      variables: body.variables ?? {},
      visibility: body.visibility ?? "private",
      enabled: body.enabled ?? true,
      timeoutSec: body.timeoutSec ?? 300,
      evaluatorAgentId: body.evaluatorAgentId ?? null,
      mcpServerId: body.mcpServerId ?? null,
      createdBy: session.user.id,
      updatedBy: session.user.id,
    })
    .returning();

  return NextResponse.json({ ...row, caseCount: 0 }, { status: 201 });
});
