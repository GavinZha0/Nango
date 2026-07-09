import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import * as storage from "@/lib/evaluation/storage";

const ROUTE = "/api/eval-suites/agents";

// GET /api/eval-suites/agents
// Returns distinct agents that have at least one eval suite,
// with suite and case counts. Used by the left panel.

export const GET = withEditor(ROUTE, async ({ session }) => {
  const rows = await storage.listAgentsWithEval(session);
  return NextResponse.json(rows);
});
