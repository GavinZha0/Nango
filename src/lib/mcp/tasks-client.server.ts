/**
 * Server-side task queries for the MCP Test page.
 *
 * Wraps `@modelcontextprotocol/ext-tasks` to list / inspect / cancel
 * tasks on an upstream MCP server. Each call opens a short-lived
 * connection via `withMcpAdminClient`, creates a task-enabled session,
 * performs one operation, and tears down — no long-lived session held
 * in the Node process.
 *
 * Phase 1: read-only task inventory for the admin test page. Does NOT
 * touch `client-providers.ts` or the agent/verification/web-auto
 * runtime paths.
 */

import "server-only";

import {
  createTaskSessionFromClient,
  type TaskListPage,
  type TaskView,
} from "@modelcontextprotocol/ext-tasks/client";
import { taskId as toTaskId } from "@modelcontextprotocol/ext-tasks/core";

import { withMcpAdminClient } from "@/lib/mcp/admin-client.server";

export type { TaskView, TaskListPage };

export async function listServerTasks(
  serverId: string,
  cursor?: string,
): Promise<TaskListPage> {
  return withMcpAdminClient({
    serverId,
    clientName: "nango-tasks-list",
    errorPrefix: "Failed to list tasks",
    fn: async ({ client }) => {
      const session = createTaskSessionFromClient(client, {
        endpointId: `nango-tasks-${serverId}`,
      });
      try {
        return await session.listTasks(cursor);
      } finally {
        await session.close();
      }
    },
  });
}

export async function getServerTask(
  serverId: string,
  taskId: string,
): Promise<TaskView> {
  return withMcpAdminClient({
    serverId,
    clientName: "nango-tasks-get",
    errorPrefix: "Failed to get task",
    fn: async ({ client }) => {
      const session = createTaskSessionFromClient(client, {
        endpointId: `nango-tasks-${serverId}`,
      });
      try {
        const controller = session.task(toTaskId(taskId));
        return await controller.snapshot();
      } finally {
        await session.close();
      }
    },
  });
}

export async function cancelServerTask(
  serverId: string,
  taskId: string,
): Promise<void> {
  return withMcpAdminClient({
    serverId,
    clientName: "nango-tasks-cancel",
    errorPrefix: "Failed to cancel task",
    fn: async ({ client }) => {
      const session = createTaskSessionFromClient(client, {
        endpointId: `nango-tasks-${serverId}`,
      });
      try {
        await session.cancelTask(toTaskId(taskId));
      } finally {
        await session.close();
      }
    },
  });
}
