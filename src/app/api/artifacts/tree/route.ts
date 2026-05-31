import "server-only";

import { NextResponse } from "next/server";

import { assembleTree } from "@/lib/artifacts/service";
import { withSession } from "@/lib/http/route-handlers";

/**
 * GET /api/artifacts/tree — return the caller's artifact tree as a
 * nested array of root nodes (system categories at the top, then
 * recursive `children`). Used by the `/artifacts` library page.
 *
 * See docs/artifact-evolution.md.
 */

const ROUTE = "/api/artifacts/tree";

export const GET = withSession(ROUTE, async ({ session }) => {
  const tree = await assembleTree(session.user.id);
  return NextResponse.json({ tree });
});
