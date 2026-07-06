import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { visibilitySql } from "@/lib/auth/permissions";
import { and, eq } from "drizzle-orm";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-servers/[id]/runs";

const querySchema = z.object({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

// GET /api/verification-servers/[id]/runs?offset=0&limit=5
// Paginated runs history for a specific MCP Server. Editor-gated.
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      offset: url.searchParams.get("offset") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        `Invalid query: ${parsed.error.issues[0]?.message ?? "bad params"}`,
      );
    }

    const [server] = await db
      .select()
      .from(McpServerTable)
      .where(
        and(
          eq(McpServerTable.id, params.id),
          visibilitySql(
            session,
            McpServerTable.visibility,
            McpServerTable.createdBy,
          )
        )
      )
      .limit(1);

    if (!server) {
      throw new ApiError(
        "NOT_FOUND",
        404,
        `MCP server with ID "${params.id}" not found or access denied.`
      );
    }

    const [rows, total] = await Promise.all([
      storage.listRecentServerRuns(server.id, parsed.data.offset, parsed.data.limit),
      storage.countServerRuns(server.id),
    ]);
    return NextResponse.json({ rows, total });
  },
);
