import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canViewResource, ResourceWithRBAC } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { countWebAutoRuns, listWebAutoRuns } from "@/lib/web-auto/storage";
import { eq } from "drizzle-orm";

const ROUTE = "/api/web-auto-suites/[id]/runs";

const idSchema = z.string().uuid();

// GET /api/web-auto-suites/[id]/runs?offset=0&limit=10
// Returns paginated run history for the given suite.
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = await params;
    const idParse = idSchema.safeParse(id);
    if (!idParse.success) {
      throw new ApiError("VALIDATION_FAILED", 400, "Invalid suite ID format.");
    }
    const suiteId = idParse.data;

    const [suite] = await db
      .select()
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, suiteId));

    if (!suite || !canViewResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found or access denied.");
    }

    const { searchParams } = new URL(req.url);
    const offset = Math.max(0, parseInt(searchParams.get("offset") ?? "0", 10) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") ?? "10", 10) || 10));

    const [rows, total] = await Promise.all([
      listWebAutoRuns(suiteId, offset, limit),
      countWebAutoRuns(suiteId),
    ]);

    const mappedRows = rows.map((r) => ({
      ...r,
      totalCount: r.passed + r.failed + r.errored,
      passedCount: r.passed,
      failedCount: r.failed,
      erroredCount: r.errored,
    }));

    return NextResponse.json({
      rows: mappedRows,
      total,
      offset,
      limit,
    });
  },
);
