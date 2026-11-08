/**
 * Server-side task session and query helpers for the MCP Test page.
 *
 * Wraps `@modelcontextprotocol/ext-tasks` to invoke task-capable tools and
 * list / inspect / cancel tasks on an upstream MCP server. Each call opens a
 * short-lived connection via `withMcpAdminClient`, creates a task-enabled
 * session, performs one operation, and tears down — no long-lived session held
 * in the Node process. Does NOT touch `client-providers.ts` or the
 * agent/verification/web-auto runtime paths.
 */

import "server-only";

import {
  createTaskSessionFromClient,
  type TaskListPage,
  type TaskView,
  type V2RequestFraming,
  type RawClientDispatch,
} from "@modelcontextprotocol/ext-tasks/client";
import { taskId as toTaskId } from "@modelcontextprotocol/ext-tasks/core";
import type { Client } from "@modelcontextprotocol/client";

import { withMcpAdminClient } from "@/lib/mcp/admin-client.server";
import { normalizeMcpToolResult } from "@/lib/mcp/tool-result-utils";
import { isJsonValue } from "@modelcontextprotocol/ext-tasks/core";

export type { TaskView, TaskListPage };
export type { V2RequestFraming, RawClientDispatch } from "@modelcontextprotocol/ext-tasks/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ClientInternal {
  _transport?: {
    send(
      message: import("@modelcontextprotocol/client").JSONRPCMessage,
      options?: { headers?: Record<string, string>; requestSignal?: AbortSignal },
    ): Promise<void>;
  };
  _requestMessageId?: number;
  _responseHandlers?: Map<number, (response: unknown) => void>;
}

/**
 * Builds V2 session options when the server negotiates modern era.
 * Returns undefined for legacy servers that don't need V2 framing.
 *
 * Exported for reuse by the call-tool route and any future ext-tasks
 * integration points.
 */
export function buildTaskSessionOptions(
  client: Client,
  clientInfo: { name: string; version: string },
  clientCapabilities: import("@modelcontextprotocol/client").ClientCapabilities,
): { rawDispatch: RawClientDispatch; v2RequestFraming: V2RequestFraming } | undefined {
  const protocolEra = client.getProtocolEra();
  if (protocolEra !== "modern") {
    return undefined;
  }

  const protocolVersion = client.getNegotiatedProtocolVersion();
  if (!protocolVersion) {
    return undefined;
  }

  // QUIRK: SDK Client wire codecs strip `resultType: "complete"` and reject
  // `resultType: "task"` with UnsupportedResultType on V2 responses. Bypass
  // `client.request()` via `client.transport` and `client._responseHandlers`
  // so `@modelcontextprotocol/ext-tasks` receives the full V2 wire envelope.
  const rawDispatch: RawClientDispatch = async (request, options) => {
    if (!isRecord(request) || typeof request["method"] !== "string") {
      throw new TypeError("MCP request must be a JSON object with a string method");
    }

    const transport = client.transport;
    if (!transport) {
      throw new Error("MCP client transport is not connected");
    }

    const internalClient = client as unknown as ClientInternal;
    const responseHandlers = internalClient._responseHandlers;
    if (!responseHandlers) {
      throw new Error("MCP client response handlers map is not available");
    }

    if (typeof internalClient._requestMessageId !== "number") {
      throw new Error("MCP client request message ID counter is not available");
    }
    const messageId = internalClient._requestMessageId++;

    const jsonrpcRequest = {
      ...request,
      jsonrpc: "2.0" as const,
      id: messageId,
    };

    return new Promise<import("@modelcontextprotocol/ext-tasks/client").JsonRpcResponse>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const requestAbort = new AbortController();

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        responseHandlers.delete(messageId);
      };

      if (options?.signal?.aborted) {
        requestAbort.abort(options.signal.reason);
        return reject(options.signal.reason);
      }
      const onAbort = (): void => {
        cleanup();
        const reason = options?.signal?.reason ?? new Error("MCP rawDispatch request was aborted");
        requestAbort.abort(reason);
        reject(reason);
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const timeoutMs = options?.context?.requestTimeoutMs ?? 60_000;
      timer = setTimeout(() => {
        cleanup();
        options?.signal?.removeEventListener("abort", onAbort);
        const timeoutErr = new Error(`MCP rawDispatch timed out after ${timeoutMs}ms for ${String(request["method"])}`);
        requestAbort.abort(timeoutErr);
        reject(timeoutErr);
      }, timeoutMs);

      // Register raw response handler directly in client._responseHandlers.
      // This receives the unmodified JSON-RPC response before SDK wire codecs
      // strip resultType: "complete" or reject resultType: "task".
      responseHandlers.set(messageId, (response: unknown) => {
        cleanup();
        options?.signal?.removeEventListener("abort", onAbort);

        if (response instanceof Error) {
          const code = isRecord(response) && typeof response["code"] === "number"
            ? response["code"]
            : -32603;
          const data = isRecord(response) && isJsonValue(response["data"])
            ? response["data"]
            : undefined;
          return resolve({
            kind: "error",
            error: {
              code,
              message: response.message,
              ...(data !== undefined ? { data } : {}),
            },
          });
        }

        if (isRecord(response)) {
          if ("result" in response && isJsonValue(response["result"])) {
            return resolve({
              kind: "result",
              result: response["result"],
            });
          }
          if ("error" in response && isRecord(response["error"])) {
            const errCode = typeof response["error"]["code"] === "number"
              ? response["error"]["code"]
              : -32603;
            const errMsg = typeof response["error"]["message"] === "string"
              ? response["error"]["message"]
              : "Unknown error";
            const data = isJsonValue(response["error"]["data"])
              ? response["error"]["data"]
              : undefined;
            return resolve({
              kind: "error",
              error: {
                code: errCode,
                message: errMsg,
                ...(data !== undefined ? { data } : {}),
              },
            });
          }
        }

        if (isJsonValue(response)) {
          return resolve({
            kind: "result",
            result: response,
          });
        }

        reject(new TypeError("Invalid JSON-RPC response format received from server"));
      });

      transport.send(
        jsonrpcRequest as unknown as import("@modelcontextprotocol/client").JSONRPCMessage,
        {
          headers: options?.context?.headers as Record<string, string> | undefined,
          requestSignal: requestAbort.signal,
        },
      ).catch((err: unknown) => {
        cleanup();
        options?.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  };

  // Convert SDK ClientCapabilities to the ext-tasks framing format.
  // We preserve all declared capabilities and add the tasks extension.
  const framingCapabilities: Record<string, import("@modelcontextprotocol/ext-tasks/core").JsonValue> = {
    ...clientCapabilities as unknown as Record<string, import("@modelcontextprotocol/ext-tasks/core").JsonValue>,
    extensions: {
      ...(clientCapabilities.extensions as Record<string, import("@modelcontextprotocol/ext-tasks/core").JsonValue> ?? {}),
      "io.modelcontextprotocol/tasks": {},
    },
  };

  const v2RequestFraming: V2RequestFraming = {
    protocolVersion,
    clientInfo,
    clientCapabilities: framingCapabilities,
  };

  return { rawDispatch, v2RequestFraming };
}

/**
 * Creates a task-enabled session from a connected MCP client.
 * Automatically provides V2 options when the server negotiates modern era.
 */
export function createTaskSession(
  client: Client,
  clientInfo: { name: string; version: string },
  clientCapabilities: import("@modelcontextprotocol/client").ClientCapabilities,
  endpointId: string,
): ReturnType<typeof createTaskSessionFromClient> {
  const v2Options = buildTaskSessionOptions(client, clientInfo, clientCapabilities);
  return v2Options
    ? createTaskSessionFromClient(client, { endpointId, ...v2Options })
    : createTaskSessionFromClient(client, { endpointId });
}

export async function listServerTasks(
  serverId: string,
  cursor?: string,
  callerRole?: string | null,
): Promise<TaskListPage> {
  return withMcpAdminClient({
    serverId,
    clientName: "nango-tasks-list",
    errorPrefix: "Failed to list tasks",
    callerRole,
    fn: async ({ client, clientInfo, clientCapabilities }) => {
      const session = createTaskSession(client, clientInfo, clientCapabilities, `nango-tasks-${serverId}`);
      try {
        if (session.capabilities.inventory !== "server-list") {
          return { tasks: [] };
        }
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
  callerRole?: string | null,
): Promise<TaskView & { result?: unknown }> {
  return withMcpAdminClient({
    serverId,
    clientName: "nango-tasks-get",
    errorPrefix: "Failed to get task",
    callerRole,
    fn: async ({ client, clientInfo, clientCapabilities }) => {
      const session = createTaskSession(client, clientInfo, clientCapabilities, `nango-tasks-${serverId}`);
      try {
        const controller = session.task(toTaskId(taskId));
        const snapshot = await controller.snapshot();
        if (snapshot.status === "completed") {
          const rawRecord = snapshot.raw as Record<string, unknown>;
          let result = rawRecord.result;
          if (result === undefined) {
            try {
              const outcome = await controller.result();
              if (outcome.status === "completed") {
                result = outcome.result as import("@modelcontextprotocol/ext-tasks/core").JsonValue;
              }
            } catch {
              // Best-effort fallback
            }
          }
          if (result !== undefined) {
            const normalized = normalizeMcpToolResult(result, { parseForUi: true });
            return {
              ...snapshot,
              result: normalized,
              raw: {
                ...snapshot.raw,
                result: normalized as import("@modelcontextprotocol/ext-tasks/core").JsonValue,
              },
            };
          }
        }
        return snapshot;
      } finally {
        await session.close();
      }
    },
  });
}

export async function cancelServerTask(
  serverId: string,
  taskId: string,
  callerRole?: string | null,
): Promise<void> {
  return withMcpAdminClient({
    serverId,
    clientName: "nango-tasks-cancel",
    errorPrefix: "Failed to cancel task",
    callerRole,
    fn: async ({ client, clientInfo, clientCapabilities }) => {
      const session = createTaskSession(client, clientInfo, clientCapabilities, `nango-tasks-${serverId}`);
      try {
        await session.cancelTask(toTaskId(taskId));
      } finally {
        await session.close();
      }
    },
  });
}
