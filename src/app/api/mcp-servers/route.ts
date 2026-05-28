import "server-only";

import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { withEditor } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import {
  nonEmptyString,
  optionalTrimmedString,
  parseBody,
  uuidString,
} from "@/lib/http/validation";

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

const createSchema = z.object({
  name: nonEmptyString,
  description: optionalTrimmedString.optional(),
  type: z.enum(["sse", "http"]),
  url: z.string().trim().url("must be a valid URL"),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  credentialId: uuidString.nullable().optional(),
  credentialHeader: optionalTrimmedString.optional(),
  visibility: z.enum(["private", "public"]).optional(),
});

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  const [row] = await db
    .insert(McpServerTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      type: body.type,
      url: body.url,
      headers: body.headers ?? null,
      credentialId: body.credentialId ?? null,
      credentialHeader: body.credentialHeader ?? null,
      enabled: true,
      visibility: body.visibility ?? "private",
      createdBy: session.user.id,
    })
    .returning();

  return NextResponse.json(row, { status: 201 });
});
