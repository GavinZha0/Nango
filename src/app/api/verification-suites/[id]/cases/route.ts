import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import { loadVisibleSuite } from "@/lib/verification/access";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-suites/[id]/cases";

// GET /api/verification-suites/[id]/cases
// All cases in the suite, alphabetical.
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadVisibleSuite(params.id, session);
    const cases = await storage.listCasesBySuite(suite.id);
    return NextResponse.json(cases);
  },
);
