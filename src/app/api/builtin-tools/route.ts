import "server-only";

import { NextResponse } from "next/server";

import { withSession } from "@/lib/http/route-handlers";
import { listBuiltinToolDescriptors } from "@/lib/builtin-tools";

const ROUTE = "/api/builtin-tools";

/**
 * GET /api/builtin-tools
 */
export const GET = withSession(ROUTE, async () => {
  return NextResponse.json(listBuiltinToolDescriptors());
});
