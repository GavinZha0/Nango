import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { visibilitySql } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { McpServerTable, WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { and, asc, eq, ilike, sql } from "drizzle-orm";

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

  let mcpServerId = body.mcpServerId ?? null;

  // Enforce 2-level nesting: A suite's parent must be a top-level group (parentId is null)
  if (body.parentId) {
    if (!mcpServerId) {
      // Auto-discover default Playwright MCP server if not explicitly passed
      const [playwrightServer] = await db
        .select({ id: McpServerTable.id })
        .from(McpServerTable)
        .where(
          and(
            eq(McpServerTable.enabled, true),
            ilike(McpServerTable.name, "%playwright%"),
          ),
        )
        .limit(1);

      if (playwrightServer) {
        mcpServerId = playwrightServer.id;
      } else {
        const [anyServer] = await db
          .select({ id: McpServerTable.id })
          .from(McpServerTable)
          .where(eq(McpServerTable.enabled, true))
          .limit(1);
        if (anyServer) {
          mcpServerId = anyServer.id;
        }
      }
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
      mcpServerId: mcpServerId,
      createdBy: session.user.id,
      updatedBy: session.user.id,
    })
    .returning();

  return NextResponse.json({ ...row, caseCount: 0 }, { status: 201 });
});
