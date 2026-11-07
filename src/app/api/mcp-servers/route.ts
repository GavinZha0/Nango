import "server-only";

import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import {
  mcpGroupSchema,
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";
import { isStdioMcpAllowed } from "@/lib/mcp/stdio-spawn.server";

const ROUTE = "/api/mcp-servers";

// GET /api/mcp-servers
// Returns the caller's own servers + all public servers. Editor-gated:
// the only UI consumer is McpPanel which is itself `requiredRole:
// "editor"` in sidebar-panel-registry, AND the response carries the
// row's `headers` jsonb (config detail editors share but regular
// users have no business reading). Locking the API to editor closes
// a defense-in-depth gap where the UI was the only enforcer.
export const GET = withEditor(ROUTE, async ({ session }) => {
  const rows = await db
    .select()
    .from(McpServerTable)
    .where(
      visibilitySql(session, McpServerTable.visibility, McpServerTable.createdBy),
    )
    .orderBy(desc(McpServerTable.createdAt));

  return NextResponse.json(rows);
});

// POST /api/mcp-servers

const createSchema = z
  .object({
    name: nonEmptyString,
    description: optionalTrimmedString.optional(),
    type: z.enum(["sse", "http", "stdio"]),
    url: optionalTrimmedString.optional(),
    headers: z.record(z.string(), z.string()).nullable().optional(),
    command: optionalTrimmedString.optional(),
    args: z.array(z.string()).nullable().optional(),
    env: z.record(z.string(), z.string()).nullable().optional(),
    cwd: optionalTrimmedString.optional(),
    credentialId: uuidString.nullable().optional(),
    credentialHeader: optionalTrimmedString.optional(),
    credentialEnvName: optionalTrimmedString.optional(),
    visibility: z.enum(["private", "public"]).optional(),
    group: mcpGroupSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "stdio") {
      if (!data.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message: "command is required for stdio MCP servers",
        });
      }
    } else {
      if (!data.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "url is required for HTTP/SSE MCP servers",
        });
      } else if (!z.string().url().safeParse(data.url).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "must be a valid URL",
        });
      }
    }
  });

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  // SECURITY: stdio spawns a local child process on the host, so it is
  // gated behind both the runtime environment allowlist and the admin role.
  if (body.type === "stdio") {
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
        "Only admins can create stdio MCP servers.",
      );
    }
  }

  const [row] = await db
    .insert(McpServerTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      type: body.type,
      url: body.type === "stdio" ? (body.url ?? "") : body.url!,
      headers: body.headers ?? null,
      command: body.command ?? null,
      args: body.args ?? null,
      env: body.env ?? null,
      cwd: body.cwd ?? null,
      credentialId: body.credentialId ?? null,
      credentialHeader: body.credentialHeader ?? null,
      credentialEnvName: body.credentialEnvName ?? null,
      enabled: true,
      visibility: body.visibility ?? "private",
      group: body.group ?? null,
      createdBy: session.user.id,
    })
    .returning();

  return NextResponse.json(row, { status: 201 });
});
