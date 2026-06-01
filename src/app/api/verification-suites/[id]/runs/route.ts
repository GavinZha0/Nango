import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadVisibleSuite } from "@/lib/verification/access";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-suites/[id]/runs";

// GET /api/verification-suites/[id]/runs?offset=0&limit=5
// Paginated history for the recent-runs banner. Visibility piggybacks
// off suite visibility (caller already has to see the suite).
//
// Response: `{ rows: VerificationRunEntity[], total: number }`.
// `total` is the absolute run count for the suite — the banner uses
// it to (a) label chips with their absolute sequence number and
// (b) decide precisely whether an "older" page exists (instead of
// the prior heuristic `rows.length === limit`, which incorrectly
// stayed `true` during a fetch transition and let users click into
// an empty page).

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
    const suite = await loadVisibleSuite(params.id, session);
    const [rows, total] = await Promise.all([
      storage.listRecentRuns(suite.id, parsed.data.offset, parsed.data.limit),
      storage.countRuns(suite.id),
    ]);
    return NextResponse.json({ rows, total });
  },
);
