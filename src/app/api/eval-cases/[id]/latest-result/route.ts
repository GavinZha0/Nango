import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import * as storage from "@/lib/evaluation/storage";
import { getCaseById } from "@/lib/evaluation/storage";

const ROUTE = "/api/eval-cases/[id]/latest-result";

// GET /api/eval-cases/[id]/latest-result
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params }) => {
    const caseId = parseInt(params.id, 10);
    if (isNaN(caseId)) {
      return NextResponse.json({ error: "Invalid case ID" }, { status: 400 });
    }

    const evalCase = await getCaseById(caseId);
    if (!evalCase) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    const result = await storage.getLatestCaseResult(caseId);
    return NextResponse.json(result);
  },
);
