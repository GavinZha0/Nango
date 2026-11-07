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
  mcpGroupSchema,
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";
import { invalidateForMcpServerChange } from "@/lib/cache/invalidation";
import { isStdioMcpAllowed } from "@/lib/mcp/stdio-spawn.server";

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
    type: z.enum(["sse", "http", "stdio"]).optional(),
    url: z.string().trim().optional(),
    headers: z.record(z.string(), z.string()).nullable().optional(),
    command: optionalTrimmedString.optional(),
    args: z.array(z.string()).nullable().optional(),
    env: z.record(z.string(), z.string()).nullable().optional(),
    cwd: optionalTrimmedString.optional(),
    credentialId: uuidString.nullable().optional(),
    credentialHeader: optionalTrimmedString.optional(),
    credentialEnvName: optionalTrimmedString.optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    group: mcpGroupSchema.optional(),
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
        type: McpServerTable.type,
        url: McpServerTable.url,
        command: McpServerTable.command,
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
      || body.command !== undefined
      || body.args !== undefined
      || body.env !== undefined
      || body.cwd !== undefined
      || body.credentialId !== undefined
      || body.credentialHeader !== undefined
      || body.credentialEnvName !== undefined
      || body.group !== undefined
      || body.tools !== undefined;
    if (editsContent && !canEditResource(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this server.");
    }

    const effectiveType = body.type ?? existing.type;

    // SECURITY: stdio spawns a local child process on the host, so editing
    // a stdio server or switching a server to stdio requires both the runtime
    // environment allowlist and the admin role.
    if ((existing.type === "stdio" || effectiveType === "stdio") && editsContent) {
      if (!isStdioMcpAllowed()) {
        throw new ApiError(
          "FORBIDDEN",
          403,
          "Stdio MCP servers are disabled in this environment.",
        );
      }
      if (session.user.role !== "admin") {
        throw new ApiError(
          "FORBIDDEN",
          403,
          "Only admins can configure stdio MCP servers.",
        );
      }
    }

    if (effectiveType === "stdio") {
      const effectiveCommand =
        body.command !== undefined ? body.command : existing.command;
      if ((body.type === "stdio" || body.command !== undefined) && !effectiveCommand) {
        throw new ApiError(
          "BAD_REQUEST",
          400,
          "command is required for stdio MCP servers.",
        );
      }
    } else {
      const effectiveUrl = body.url !== undefined ? body.url : existing.url;
      if (
        (body.type !== undefined || body.url !== undefined)
        && (!effectiveUrl || !z.string().url().safeParse(effectiveUrl).success)
      ) {
        throw new ApiError(
          "BAD_REQUEST",
          400,
          "url must be a valid URL for HTTP/SSE MCP servers.",
        );
      }
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
    if (body.command !== undefined) updates.command = body.command;
    if (body.args !== undefined) updates.args = body.args;
    if (body.env !== undefined) updates.env = body.env;
    if (body.cwd !== undefined) updates.cwd = body.cwd;
    if (body.credentialId !== undefined) updates.credentialId = body.credentialId;
    if (body.credentialHeader !== undefined) updates.credentialHeader = body.credentialHeader;
    if (body.credentialEnvName !== undefined) updates.credentialEnvName = body.credentialEnvName;
    if (body.group !== undefined) updates.group = body.group;
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
