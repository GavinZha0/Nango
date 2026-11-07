import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import { getServerTask } from "@/lib/mcp/tasks-client.server";
import { getConfigNumber } from "@/lib/config";
import {
  DEFAULT_TASK_POLL_HISTORY_LIMIT,
  normalizePollHistoryLimit,
} from "@/lib/mcp/task-poll-utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp-servers/[id]/tasks/[taskId]
 *
 * Returns a single TaskView snapshot plus `pollHistoryLimit`.
 */
export const GET = withEditor<{ id: string; taskId: string }>(
  "/api/mcp-servers/[id]/tasks/[taskId]",
  async ({ params }) => {
    const task = await getServerTask(params.id, params.taskId);
    const pollHistoryLimit = normalizePollHistoryLimit(
      getConfigNumber("mcp.task_poll_history_limit", DEFAULT_TASK_POLL_HISTORY_LIMIT),
    );
    return NextResponse.json({ ...task, pollHistoryLimit });
  },
);
