/**
 * GET /api/eval-runs/[id] — run detail + all case results.
 * Response: { run: EvalRunEntity, results: EvalCaseResultEntity[] }.
 */

import "server-only";

import { NextResponse } from "next/server";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadSuite } from "@/lib/evaluation/access";
import * as storage from "@/lib/evaluation/storage";

const ROUTE = "/api/eval-runs/[id]";

export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const run = await storage.getRunById(params.id);
    if (!run) {
      throw new ApiError("NOT_FOUND", 404, "Eval run not found.");
    }

    // Piggyback on suite visibility for permission check.
    await loadSuite(run.suiteId, session);

    const results = await storage.listCaseResults(run.id);
    return NextResponse.json({ run, results });
  },
);
