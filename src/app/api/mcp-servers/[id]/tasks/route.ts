import "server-only";

import { NextResponse } from "next/server";

import { withEditor } from "@/lib/http/route-handlers";
import { listServerTasks } from "@/lib/mcp/tasks-client.server";
import { getConfigNumber } from "@/lib/config";
import {
  DEFAULT_TASK_POLL_HISTORY_LIMIT,
  normalizePollHistoryLimit,
} from "@/lib/mcp/task-poll-utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp-servers/[id]/tasks?cursor=...
 *
 * Lists server-owned tasks via the ext-tasks session API.
 * Returns a TaskListPage { tasks, nextCursor?, pollHistoryLimit }.
 */
export const GET = withEditor<{ id: string }>(
  "/api/mcp-servers/[id]/tasks",
  async ({ params, req, session }) => {
    const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;
    const page = await listServerTasks(params.id, cursor, session.user.role);
    const pollHistoryLimit = normalizePollHistoryLimit(
      getConfigNumber("mcp.task_poll_history_limit", DEFAULT_TASK_POLL_HISTORY_LIMIT),
    );
    return NextResponse.json({ ...page, pollHistoryLimit });
  },
);
