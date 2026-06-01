import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadVisibleSuite } from "@/lib/verification/access";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-runs/[id]";

const idSchema = z.string().uuid();

// GET /api/verification-runs/[id]
// Returns the run header + every verification_case_result row for it.
// Used by the "history view" snapshot mode in the suite editor.
//
// Visibility piggybacks off the parent suite — if the caller can see
// the suite they can see its runs.

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
    // Throws 404 if the user can't see the parent suite.
    await loadVisibleSuite(run.suiteId, session);

    const results = await storage.listResultsByRun(run.id);
    return NextResponse.json({ run, results });
  },
);
