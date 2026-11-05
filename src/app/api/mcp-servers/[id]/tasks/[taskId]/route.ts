import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import { getServerTask } from "@/lib/mcp/tasks-client.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp-servers/[id]/tasks/[taskId]
 *
 * Returns a single TaskView snapshot.
 */
export const GET = withEditor<{ id: string; taskId: string }>(
  "/api/mcp-servers/[id]/tasks/[taskId]",
  async ({ params }) => {
    const task = await getServerTask(params.id, params.taskId);
    return NextResponse.json(task);
  },
);
