import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canViewResource, ResourceWithRBAC } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { startWebAutoSuiteRun } from "@/lib/web-auto/orchestrator";
import { eq } from "drizzle-orm";

const ROUTE = "/api/web-auto-runs";

const startRunSchema = z
  .object({
    suiteId: z.string().uuid(),
  })
  .strict();

// POST /api/web-auto-runs
// Starts an async background suite run.
// Returns { runId, totalCount } with HTTP 202 immediately.
export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, startRunSchema);

  const [suite] = await db
    .select()
    .from(WebAutoSuiteTable)
    .where(eq(WebAutoSuiteTable.id, body.suiteId));

  if (!suite || !canViewResource(suite as unknown as ResourceWithRBAC, session)) {
    throw new ApiError(
      "NOT_FOUND",
      404,
      `Web Auto suite with ID "${body.suiteId}" not found or access denied.`,
    );
  }

  if (!suite.mcpServerId) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "Suite does not have a Playwright MCP server configured.",
    );
  }

  const result = await startWebAutoSuiteRun({
    suiteId: body.suiteId,
    ownerId: session.user.id,
  });

  return NextResponse.json(result, { status: 202 });
});
