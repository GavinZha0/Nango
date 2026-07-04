import "server-only";

import { NextResponse } from "next/server";
import { withSession } from "@/lib/http/route-handlers";
import { getActiveTasks } from "@/lib/runner/active-tasks";

const ROUTE = "/api/runs/active";

export const GET = withSession(ROUTE, async ({ session }) => {
  const ownerId = session.user.id;
  const activeTasks = await getActiveTasks(ownerId);
  return NextResponse.json({ activeTasks });
});
