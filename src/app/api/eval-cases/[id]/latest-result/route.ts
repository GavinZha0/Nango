import "server-only";

import { NextResponse } from "next/server";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import * as storage from "@/lib/evaluation/storage";
import { loadCase } from "@/lib/evaluation/access";

const ROUTE = "/api/eval-cases/[id]/latest-result";

// GET /api/eval-cases/[id]/latest-result
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const caseId = parseInt(params.id, 10);
    if (isNaN(caseId)) {
      throw new ApiError("VALIDATION_FAILED", 400, "Invalid eval case id.");
    }

    // SECURITY: loadCase enforces suite visibility with an opaque 404 —
    // foreign private cases are indistinguishable from missing ones.
    await loadCase(caseId, session);

    const result = await storage.getLatestCaseResult(caseId);
    return NextResponse.json(result);
  },
);
