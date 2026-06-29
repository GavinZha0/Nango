/**
 * GET /api/eval-suites/[id]/runs?offset=0&limit=5
 * Paginated run history for the recent-runs banner.
 * Response: { rows: EvalRunEntity[], total: number }.
 */

import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadSuite } from "@/lib/evaluation/access";
import * as storage from "@/lib/evaluation/storage";

const ROUTE = "/api/eval-suites/[id]/runs";

const querySchema = z.object({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

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
    const suite = await loadSuite(params.id, session);
    const [rows, total] = await Promise.all([
      storage.listRecentRuns(suite.id, parsed.data.offset, parsed.data.limit),
      storage.countRuns(suite.id),
    ]);
    return NextResponse.json({ rows, total });
  },
);
