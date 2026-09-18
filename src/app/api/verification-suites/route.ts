import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";

import { visibilitySql } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { McpServerTable, VerificationSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { suiteVariablesSchema } from "@/lib/testing/variables-schema";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-suites";

// GET /api/verification-suites
// Returns visible verification suites (alphabetical).

export const GET = withEditor(ROUTE, async ({ session }) => {
  // Projection mirrors `select()` but pulls a correlated COUNT for the
  // case rows of each suite, so the left-panel can render a badge
  // without an N+1 fetch.
  const rows = await db
    .select({
      id: VerificationSuiteTable.id,
      name: VerificationSuiteTable.name,
      description: VerificationSuiteTable.description,
      groupId: VerificationSuiteTable.groupId,
      mcpServerId: VerificationSuiteTable.mcpServerId,
      mcpServerName: VerificationSuiteTable.mcpServerName,
      serverGroup: sql<string | null>`(
        select "group" from "mcp_server"
        where "mcp_server"."id" = "verification_suite"."mcp_server_id"
      )`,
      serverName: sql<string | null>`(
        select coalesce("server_title", "name") from "mcp_server"
        where "mcp_server"."id" = "verification_suite"."mcp_server_id"
      )`,
      toolPrefixRule: VerificationSuiteTable.toolPrefixRule,
      visibility: VerificationSuiteTable.visibility,
      variables: VerificationSuiteTable.variables,
      enabled: VerificationSuiteTable.enabled,
      timeoutSec: VerificationSuiteTable.timeoutSec,
      createdBy: VerificationSuiteTable.createdBy,
      updatedBy: VerificationSuiteTable.updatedBy,
      createdAt: VerificationSuiteTable.createdAt,
      updatedAt: VerificationSuiteTable.updatedAt,
      caseCount: sql<number>`(
        select count(*)::int from "verification_case"
        where "verification_case"."suite_id" = "verification_suite"."id"
      )`,
    })
    .from(VerificationSuiteTable)
    .where(
      visibilitySql(
        session,
        VerificationSuiteTable.visibility,
        VerificationSuiteTable.createdBy,
      ),
    )
    .orderBy(asc(VerificationSuiteTable.name));

  return NextResponse.json(rows);
});

// POST /api/verification-suites
// Create a new suite. Editor+ only.

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    groupId: z.string().uuid().optional().nullable(),
    groupName: z.string().trim().min(1).max(100).optional().nullable(),
    mcpServerId: z.string().uuid().optional().nullable(),
    toolPrefixRule: z
      .object({
        mode: z.enum(["none", "add", "remove"]),
        prefix: z.string(),
      })
      .optional()
      .nullable(),
    variables: suiteVariablesSchema.optional(),
    visibility: z.enum(["private", "public"]).optional(),
    timeoutSec: z.number().int().min(10).max(7200).optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  // Snapshot the bound server's display name onto the suite
  let mcpServerName: string | null = null;
  if (body.mcpServerId) {
    const [server] = await db
      .select({ name: McpServerTable.name, serverTitle: McpServerTable.serverTitle })
      .from(McpServerTable)
      .where(eq(McpServerTable.id, body.mcpServerId))
      .limit(1);
    if (!server) {
      throw new ApiError("NOT_FOUND", 404, "MCP server not found.");
    }
    mcpServerName = server.serverTitle || server.name;
  }

  let resolvedGroupId = body.groupId ?? null;
  if (!resolvedGroupId && body.groupName) {
    const group = await storage.getOrCreateGroupByName(body.groupName);
    resolvedGroupId = group.id;
  }

  try {
    const [row] = await db
      .insert(VerificationSuiteTable)
      .values({
        name: body.name,
        description: body.description ?? null,
        groupId: resolvedGroupId,
        mcpServerId: body.mcpServerId ?? null,
        mcpServerName,
        toolPrefixRule: body.toolPrefixRule ?? null,
        variables: body.variables ?? {},
        visibility: body.visibility ?? "private",
        timeoutSec: body.timeoutSec ?? 300,
        createdBy: session.user.id,
        updatedBy: session.user.id,
      })
      .returning();

    return NextResponse.json({ ...row, caseCount: 0 }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        "CONFLICT",
        409,
        `A verification suite named "${body.name}" already exists for your account.`,
      );
    }
    throw err;
  }
});
