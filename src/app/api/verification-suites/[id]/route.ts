import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
} from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import {
  McpServerTable,
  VerificationCaseTable,
  VerificationSuiteTable,
} from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { suiteVariablesSchema } from "@/lib/testing/variables-schema";
import { loadVisibleSuite } from "@/lib/verification/access";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-suites/[id]";

// GET /api/verification-suites/[id]
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadVisibleSuite(params.id, session);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(VerificationCaseTable)
      .where(eq(VerificationCaseTable.suiteId, suite.id));

    let serverGroup: string | null = null;
    let serverName: string | null = suite.mcpServerName;

    if (suite.mcpServerId) {
      const serverRow = await db
        .select({
          name: McpServerTable.name,
          group: McpServerTable.group,
          serverTitle: McpServerTable.serverTitle,
        })
        .from(McpServerTable)
        .where(eq(McpServerTable.id, suite.mcpServerId))
        .limit(1);

      if (serverRow[0]) {
        serverGroup = serverRow[0].group ? serverRow[0].group.trim() : null;
        serverName = serverRow[0].serverTitle || serverRow[0].name;
      }
    }

    return NextResponse.json({
      ...suite,
      caseCount: count,
      serverGroup,
      serverName,
    });
  },
);

// PATCH /api/verification-suites/[id]
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
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
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    timeoutSec: z.number().int().min(10).max(7200).optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const suite = await loadVisibleSuite(params.id, session);

    const rbac = {
      visibility: suite.visibility as "private" | "public",
      createdBy: suite.createdBy,
    };

    const contentEdit =
      body.name !== undefined
      || body.description !== undefined
      || body.groupId !== undefined
      || body.groupName !== undefined
      || body.mcpServerId !== undefined
      || body.toolPrefixRule !== undefined
      || body.variables !== undefined
      || body.timeoutSec !== undefined;
    const flagEdit =
      body.enabled !== undefined || body.visibility !== undefined;

    if (contentEdit && !canEditResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot edit this verification suite.",
      );
    }
    if (flagEdit && !canChangeVisibility(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled.",
      );
    }

    const updates: Record<string, unknown> = { updatedBy: session.user.id };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.variables !== undefined) updates.variables = body.variables;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.visibility !== undefined) updates.visibility = body.visibility;
    if (body.timeoutSec !== undefined) updates.timeoutSec = body.timeoutSec;
    if (body.toolPrefixRule !== undefined) {
      updates.toolPrefixRule = body.toolPrefixRule;
    }

    if (body.mcpServerId !== undefined) {
      updates.mcpServerId = body.mcpServerId;
      if (body.mcpServerId) {
        const [server] = await db
          .select({ name: McpServerTable.name, serverTitle: McpServerTable.serverTitle })
          .from(McpServerTable)
          .where(eq(McpServerTable.id, body.mcpServerId))
          .limit(1);
        if (server) {
          updates.mcpServerName = server.serverTitle || server.name;
        }
      } else {
        updates.mcpServerName = null;
      }
    }

    if (body.groupId !== undefined) {
      updates.groupId = body.groupId;
    } else if (body.groupName !== undefined) {
      if (body.groupName) {
        const group = await storage.getOrCreateGroupByName(body.groupName);
        updates.groupId = group.id;
      } else {
        updates.groupId = null;
      }
    }

    updates.updatedAt = sql`CURRENT_TIMESTAMP`;

    try {
      const [updated] = await db
        .update(VerificationSuiteTable)
        .set(updates)
        .where(eq(VerificationSuiteTable.id, suite.id))
        .returning();

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(VerificationCaseTable)
        .where(eq(VerificationCaseTable.suiteId, suite.id));
      return NextResponse.json({ ...updated, caseCount: count });
    } catch (err) {
      if (isUniqueViolation(err) && body.name) {
        throw new ApiError(
          "CONFLICT",
          409,
          `A verification suite named "${body.name}" already exists for your account.`,
        );
      }
      throw err;
    }
  },
);

// DELETE /api/verification-suites/[id]
export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadVisibleSuite(params.id, session);
    const rbac = {
      visibility: suite.visibility as "private" | "public",
      createdBy: suite.createdBy,
    };
    if (!canDeleteResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this verification suite.",
      );
    }
    await db
      .delete(VerificationSuiteTable)
      .where(eq(VerificationSuiteTable.id, suite.id));
    return new NextResponse(null, { status: 204 });
  },
);
