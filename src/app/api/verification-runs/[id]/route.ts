import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { visibilitySql } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadVisibleSuite } from "@/lib/verification/access";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-runs/[id]";

const idSchema = z.string().uuid();

// GET /api/verification-runs/[id]
// Returns the run header + every verification_case_result row for it.
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const runId = idSchema.safeParse(params.id);
    if (!runId.success) {
      throw new ApiError("NOT_FOUND", 404, "Verification run not found.");
    }
    const run = await storage.getRunById(runId.data);
    if (!run) {
      throw new ApiError("NOT_FOUND", 404, "Verification run not found.");
    }

    if (run.suiteId) {
      await loadVisibleSuite(run.suiteId, session);
    } else if (run.mcpServerId) {
      const [server] = await db
        .select()
        .from(McpServerTable)
        .where(
          and(
            eq(McpServerTable.id, run.mcpServerId),
            visibilitySql(
              session,
              McpServerTable.visibility,
              McpServerTable.createdBy,
            )
          )
        )
        .limit(1);

      if (!server) {
        throw new ApiError("NOT_FOUND", 404, "Verification run not found.");
      }
    } else {
      throw new ApiError("BAD_REQUEST", 400, "Invalid run data.");
    }

    // SECURITY: server-wide runs may contain other users' private suites'
    // results — the server row being visible must not expose them.
    // Suite-scoped runs are fully gated by loadVisibleSuite above, so
    // their results all belong to one already-visible suite.
    const viewer = {
      userId: session.user.id,
      isAdmin: session.user.role === "admin",
      isEditor: true,
    };
    const results = run.suiteId
      ? await storage.listResultsByRun(run.id)
      : await storage.listResultsByRunForViewer(run.id, viewer);

    // Run-header counts cover the whole run; rows outside the viewer's
    // visibility are omitted above, so surface the visible row count to
    // avoid "totals > visible results" confusion in the UI.
    return NextResponse.json({ run, results, visibleCount: results.length });
  },
);
