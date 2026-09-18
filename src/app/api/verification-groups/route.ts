import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import * as storage from "@/lib/verification/storage";

const ROUTE = "/api/verification-groups";

// GET /api/verification-groups
// Returns all verification groups that have at least one active, visible suite for the viewer.
export const GET = withEditor(ROUTE, async ({ session }) => {
  const viewer = {
    userId: session.user.id,
    isAdmin: session.user.role === "admin",
    isEditor: true,
  };

  const groups = await storage.listGroupsWithActiveSuites(viewer);
  return NextResponse.json(groups);
});
