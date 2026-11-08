import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import { cancelServerTask } from "@/lib/mcp/tasks-client.server";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp-servers/[id]/tasks/[taskId]/cancel
 */
export const POST = withEditor<{ id: string; taskId: string }>(
  "/api/mcp-servers/[id]/tasks/[taskId]/cancel",
  async ({ params, session }) => {
    await cancelServerTask(params.id, params.taskId, session.user.role);
    return new NextResponse(null, { status: 204 });
  },
);
