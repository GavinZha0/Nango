import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor } from "@/lib/http/route-handlers";
import { nonEmptyString, parseBody } from "@/lib/http/validation";
import { withMcpAdminClient } from "@/lib/mcp/admin-client.server";
import { createTaskSession } from "@/lib/mcp/tasks-client.server";
import { resultFromTaskOutcome } from "@modelcontextprotocol/ext-tasks/client";

import { normalizeMcpToolResult } from "@/lib/mcp/tool-result-utils";
import {
  DEFAULT_TASK_POLL_HISTORY_LIMIT,
  normalizePollHistoryLimit,
} from "@/lib/mcp/task-poll-utils";

import { getConfigMs, getConfigNumber } from "@/lib/config";

export const dynamic = "force-dynamic";

const callToolSchema = z.object({
  toolName: nonEmptyString,
  args: z.record(z.string(), z.unknown()).optional(),
});

const DEFAULT_EXECUTION_TIMEOUT_S = 60;

/**
 * Checks whether a specific tool requires or supports task-based execution
 * according to the cached tool metadata in `mcp_server.tools`.
 */
function needsTaskSession(
  tools: ReadonlyArray<{ name: string; execution?: { taskSupport?: string } }>,
  toolName: string,
): boolean {
  const tool = tools.find((t) => t.name === toolName);
  const taskSupport = tool?.execution?.taskSupport;
  return taskSupport === "required" || taskSupport === "optional";
}

/**
 * Checks whether the live negotiated server capabilities advertise MCP tasks
 * support (either legacy V1 `capabilities.tasks` or V2 `extensions["io.modelcontextprotocol/tasks"]`),
 * guarding against stale `mcp_server.tools` metadata in the database.
 */
function hasServerTasksCapability(
  capabilities: Record<string, unknown> | undefined,
): boolean {
  if (!capabilities) return false;
  if (capabilities.tasks !== undefined) return true;
  const extensions = capabilities.extensions;
  if (typeof extensions === "object" && extensions !== null && !Array.isArray(extensions)) {
    return "io.modelcontextprotocol/tasks" in extensions;
  }
  return false;
}

/**
 * POST /api/mcp-servers/[id]/call-tool
 *
 * Response shapes:
 *   Immediate: { mode: "result", result: ... }
 *   Task:      { mode: "task", taskId: string, operation: string }
 */
export const POST = withEditor<{ id: string }>(
  "/api/mcp-servers/[id]/call-tool",
  async ({ req, params, session }) => {
    const body = await parseBody(req, callToolSchema);
    const timeoutMs = getConfigMs(
      "mcp.execution_timeout",
      DEFAULT_EXECUTION_TIMEOUT_S,
    );
    const snapshotMaxBytes = getConfigNumber("mcp.test_snapshot_max_kb", 32) * 1024;
    const pollHistoryLimit = normalizePollHistoryLimit(
      getConfigNumber("mcp.task_poll_history_limit", DEFAULT_TASK_POLL_HISTORY_LIMIT),
    );

    const response = await withMcpAdminClient({
      serverId: params.id,
      clientName: "nango-tool-call",
      errorPrefix: "Tool call failed",
      callerRole: session.user.role,
      fn: async ({ client, clientInfo, clientCapabilities, server }) => {
        const protocolEra = client.getProtocolEra();
        const isV2 = protocolEra === "modern";
        const serverCaps = client.getServerCapabilities?.() as
          | Record<string, unknown>
          | undefined;

        const useTaskSession =
          isV2 ||
          hasServerTasksCapability(serverCaps) ||
          needsTaskSession(server.tools ?? [], body.toolName);

        // For pure legacy V1 servers with non-task tools, call directly via client.callTool
        if (!useTaskSession) {
          const raw = await client.callTool(
            {
              name: body.toolName,
              arguments: body.args ?? {},
            },
            { timeout: timeoutMs },
          );
          return {
            mode: "result" as const,
            result: normalizeMcpToolResult(raw, { parseForUi: true }),
          };
        }

        // Always use ext-tasks session for V2 servers or task-declared tools.
        // This uniformly handles both immediate results and task creation.
        const session = createTaskSession(
          client,
          clientInfo,
          clientCapabilities,
          `nango-call-${params.id}`,
        );
        let skipSessionClose = false;
        try {
          const execution = await session.callTool(
            body.toolName,
            (body.args ?? {}) as Record<string, import("@modelcontextprotocol/ext-tasks/core").JsonValue>,
            { requestTimeoutMs: timeoutMs },
          );

          if (execution.kind === "task") {
            // Task was created — persist reference and return task info
            const taskId = execution.handle.taskId;
            const operation = execution.handle.operation;
            let initialTask: import("@modelcontextprotocol/ext-tasks/client").TaskView | undefined;
            try {
              const controller = session.task(execution.handle.taskId);
              initialTask = await controller.snapshot();
            } catch {
              // Best-effort snapshot
            }
            await execution.handoff(async (_reference) => {
              // QUIRK: `@modelcontextprotocol/ext-tasks` detaches handed-off tasks from
              // `activeExecutions` asynchronously via `result().finally()`. Calling
              // `session.close()` synchronously in `finally` below would still see the
              // task as active and send `tasks/cancel` to the upstream server.
              skipSessionClose = true;
            });
            return {
              mode: "task" as const,
              taskId,
              operation,
              ...(initialTask !== undefined ? { initialTask } : {}),
            };
          }

          // Immediate result
          const { outcome } = await execution.settle();
          const result = resultFromTaskOutcome(outcome);
          return {
            mode: "result" as const,
            result: normalizeMcpToolResult(result, { parseForUi: true }),
          };
        } finally {
          if (!skipSessionClose) {
            await session.close();
          }
        }
      },
    });

    return NextResponse.json({ ...response, snapshotMaxBytes, pollHistoryLimit });
  },
);
