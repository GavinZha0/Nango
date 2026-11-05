import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import { listServerTasks } from "@/lib/mcp/tasks-client.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp-servers/[id]/tasks?cursor=...
 *
 * Lists server-owned tasks via the ext-tasks session API.
 * Returns a TaskListPage { tasks, nextCursor? }.
 */
export const GET = withEditor<{ id: string }>(
  "/api/mcp-servers/[id]/tasks",
  async ({ params, req }) => {
    const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;
    const page = await listServerTasks(params.id, cursor);
    return NextResponse.json(page);
  },
);
