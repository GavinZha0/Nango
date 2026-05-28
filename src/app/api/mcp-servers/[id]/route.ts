import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
} from "@/lib/auth/permissions";
import {
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";
import { invalidateForMcpServerChange } from "@/lib/cache/invalidation";

const ROUTE = "/api/mcp-servers/[id]";

// PATCH /api/mcp-servers/[id]

const mcpToolSnapshotSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean(),
});

const updateSchema = z
  .object({
    name: nonEmptyString.optional(),
    description: optionalTrimmedString.optional(),
    type: z.enum(["sse", "http"]).optional(),
    url: z.string().trim().url("must be a valid URL").optional(),
    headers: z.record(z.string(), z.string()).nullable().optional(),
    credentialId: uuidString.nullable().optional(),
    credentialHeader: optionalTrimmedString.optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    /** Full tools snapshot replacement (used when refreshing or toggling individual tools). */
    tools: z.array(mcpToolSnapshotSchema).optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = params;

    const [existing] = await db
      .select({
        createdBy: McpServerTable.createdBy,
        visibility: McpServerTable.visibility,
      })
      .from(McpServerTable)
      .where(eq(McpServerTable.id, id))
      .limit(1);

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Server not found.");
    }

    const body = await parseBody(req, updateSchema);

    const rbac = {
      // mcp_server has no `source` column today (always treated as local).
      source: "local" as const,
      visibility: existing.visibility as "private" | "public",
      createdBy: existing.createdBy,
    };

    // Content / config edits — open to any editor with public access.
    const editsContent =
      body.name !== undefined
      || body.description !== undefined
      || body.type !== undefined
      || body.url !== undefined
      || body.headers !== undefined
      || body.credentialId !== undefined
      || body.credentialHeader !== undefined
      || body.tools !== undefined;
    if (editsContent && !canEditResource(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this server.");
    }
    // Visibility / enabled — owner or admin only.
    if (
      (body.visibility !== undefined || body.enabled !== undefined)
      && !canChangeVisibility(rbac, session)
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled.",
      );
    }

    const updates: Partial<typeof McpServerTable.$inferInsert> = {
      updatedAt: new Date(),
      updatedBy: session.user.id,
    };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.type !== undefined) updates.type = body.type;
    if (body.url !== undefined) updates.url = body.url;
    if (body.headers !== undefined) updates.headers = body.headers;
    if (body.credentialId !== undefined) updates.credentialId = body.credentialId;
    if (body.credentialHeader !== undefined) updates.credentialHeader = body.credentialHeader;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.visibility !== undefined) updates.visibility = body.visibility;
    if (body.tools !== undefined) updates.tools = body.tools;

    const [row] = await db
      .update(McpServerTable)
      .set(updates)
      .where(eq(McpServerTable.id, id))
      .returning();

    // Any field on McpServer feeds the cached transport (URL, headers,
    // bound credential, transport type) or the agent specs that bind it.
    // Evict the provider and drop dependent specs.
    await invalidateForMcpServerChange(id);

    return NextResponse.json(row);
  },
);

// DELETE /api/mcp-servers/[id]

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;

    // Pre-check + permission so we can invalidate BEFORE the row is
    // removed. builtin_agent_tool.mcp_server_id is ON DELETE SET NULL:
    // after the delete the reverse-index query inside
    // invalidateForMcpServerChange would return zero dependent agents,
    // leaving their cached specs pointing at a vanished server.
    const [existing] = await db
      .select({
        id: McpServerTable.id,
        createdBy: McpServerTable.createdBy,
        visibility: McpServerTable.visibility,
      })
      .from(McpServerTable)
      .where(eq(McpServerTable.id, id))
      .limit(1);

    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Server not found.");
    }
    if (
      !canDeleteResource(
        {
          source: "local",
          visibility: existing.visibility as "private" | "public",
          createdBy: existing.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this server.",
      );
    }

    await invalidateForMcpServerChange(id);
    await db.delete(McpServerTable).where(eq(McpServerTable.id, id));

    return new NextResponse(null, { status: 204 });
  },
);
