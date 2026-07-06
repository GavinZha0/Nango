import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { canEditResource, visibilitySql } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadVisibleSuite } from "@/lib/verification/access";
import { startSuiteRun, startServerRun } from "@/lib/verification/run-orchestrator";

const ROUTE = "/api/verification-runs";

// POST /api/verification-runs
// Body: { suiteId } OR { mcpServerId }
// Starts an ASYNC run (either single suite/tool or whole server).
const startSchema = z
  .object({
    suiteId: z.string().uuid().optional(),
    mcpServerId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (data) => (data.suiteId && !data.mcpServerId) || (!data.suiteId && data.mcpServerId),
    { message: "Either suiteId or mcpServerId must be provided, but not both." }
  );

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, startSchema);

  if (body.suiteId) {
    const suite = await loadVisibleSuite(body.suiteId, session);

    if (
      !canEditResource(
        {
          visibility: suite.visibility as "private" | "public",
          createdBy: suite.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot run this verification suite.",
      );
    }

    if (!suite.enabled) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Verification suite is disabled.",
      );
    }

    try {
      const { runId, totalCount } = await startSuiteRun({
        suiteId: suite.id,
        ownerId: session.user.id,
        triggeredBy: "manual",
      });
      return NextResponse.json({ runId, totalCount }, { status: 202 });
    } catch (err) {
      if (err instanceof Error && err.message === "WORKFLOW_TESTS_V2") {
        throw new ApiError(
          "NOT_IMPLEMENTED",
          501,
          "Workflow verification suites are coming in a later release.",
          { code: "WORKFLOW_TESTS_V2" },
        );
      }
      throw err;
    }
  } else {
    // Run all suites under this MCP server
    const [server] = await db
      .select()
      .from(McpServerTable)
      .where(
        and(
          eq(McpServerTable.id, body.mcpServerId!),
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
        `MCP server with ID "${body.mcpServerId}" not found or access denied.`
      );
    }

    if (!server.enabled) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "MCP server is disabled.",
      );
    }

    const { runId, totalCount } = await startServerRun({
      mcpServerId: server.id,
      ownerId: session.user.id,
      triggeredBy: "manual",
    });
    return NextResponse.json({ runId, totalCount }, { status: 202 });
  }
});
