import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canViewResource, ResourceWithRBAC } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoRunTable, WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { listWebAutoCaseResultsByRun } from "@/lib/web-auto/storage";
import { eq } from "drizzle-orm";

const ROUTE = "/api/web-auto-runs/[id]";

const idSchema = z.string().uuid();

// GET /api/web-auto-runs/[id]
// Returns run details and all case results for this run.
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = await params;
    const idParse = idSchema.safeParse(id);
    if (!idParse.success) {
      throw new ApiError("VALIDATION_FAILED", 400, "Invalid run ID format.");
    }
    const runId = idParse.data;

    const [run] = await db
      .select()
      .from(WebAutoRunTable)
      .where(eq(WebAutoRunTable.id, runId));

    if (!run) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto run not found.");
    }

    const [suite] = await db
      .select()
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, run.suiteId));

    if (!suite || !canViewResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found or access denied.");
    }

    const results = await listWebAutoCaseResultsByRun(runId);

    return NextResponse.json({
      run,
      results,
    });
  },
);
