/**
 * Graceful MCP client providers for Built-in agents.
 *
 * Wraps each discovered MCP tool as a Vercel AI SDK `dynamicTool` so
 * CopilotKit's `mcpClients` integration can spread them into
 * `streamText.tools`.
 *
 * WARNING: do not "simplify" by swapping back to `@ai-sdk/mcp`. Its
 * 1.x line mutates `transport.protocolVersion` directly, which
 * `@modelcontextprotocol/sdk` >= 1.29 forbids (getter-only); the
 * 2.x line is ai-sdk-v4 only. The hand-rolled wrapper below sits on
 * the official MCP SDK and bypasses both traps.
 *
 * See docs/builtin-runtime.md.
 */

import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { normalizeAndDeduplicateMcpResult } from "@/lib/mcp/tool-result-utils";
import { dynamicTool, jsonSchema } from "ai";
import type { MCPClientProvider } from "@/lib/copilot/index.server";

import { getConfigMs } from "@/lib/config";
import { childLogger } from "@/lib/observability/logger";
import { wrapToolExecute } from "@/lib/runner/tool-failure";

const DEFAULT_DISCOVERY_TIMEOUT_S = 5;

export interface GracefulMcpProviderConfig {
  /** Server display name used in log lines. */
  label: string;
  type: "sse" | "http";
  url: string;
  /** Headers to attach to the upstream connection. */
  headers?: Record<string, string>;
}

/**
 * QUIRK: opaque `Record<string, unknown>` instead of `ToolSet` because
 * the strict `ToolSet` type imported by CopilotKit's `MCPClientProvider`
 * lives in a copy of the `ai` package that may not be the same version
 * as the one we import `dynamicTool` from. Runtime shape is identical;
 * the type-system incompatibility is purely structural and resolved
 * with a single cast at the CopilotKit boundary in `tools()`.
 */
type RawToolSet = Record<string, unknown>;

/**
 * Discovery / connection state observable to callers without forcing
 * an `await provider.tools()`. Callers (dispatch layer) read this on
 * every borrow to surface degradation events.
 */
export type GracefulMcpProviderHealth =
  | "warming-up"           // initial state; discovery still in flight
  | "ready"                // discovery succeeded; tools available
  | "discovery-failed"     // connect or listTools threw
  | "discovery-timed-out"; // exceeded mcp.discovery_timeout

export interface GracefulMcpProvider extends MCPClientProvider {
  /** Release the underlying MCP client. Idempotent. */
  close(): Promise<void>;
  /** Human-readable MCP server name (mirror of {@link McpServerConfig.label}).
   *  Exposed so callers — e.g. `dispatch/builtin.ts::recordDegradation` —
   *  can write a `refName` next to the `mcpServerId` ref without
   *  re-querying the DB. */
  readonly label: string;
  /** Current discovery state. Stable across calls — `tools()` does not mutate it. */
  readonly health: GracefulMcpProviderHealth;
  /** Reason text when {@link health} is a failure state, otherwise null. */
  readonly lastErrorMessage: string | null;
}

/**
 * Build a graceful MCPClientProvider. Discovery is kicked off
 * immediately in the background; the first chat call awaits whichever
 * arrives first (cached tools, warmup completion, or — on timeout —
 * an empty set).
 */
export function createGracefulMcpProvider(
  cfg: GracefulMcpProviderConfig,
): GracefulMcpProvider {
  const log = childLogger({ component: "mcp-provider", label: cfg.label });
  let cachedTools: RawToolSet | null = null;
  let client: Client | null = null;
  let closed = false;
  let health: GracefulMcpProviderHealth = "warming-up";
  let lastErrorMessage: string | null = null;

  // CONTRACT: `connectionPromise` must be retained so it can be
  // awaited / cleaned up by the timeout branch — see comment below.
  const connectionPromise = connectAndList(cfg);
  const warmup: Promise<void> = (async () => {
    try {
      const result = await Promise.race([
        connectionPromise,
        timeout(getConfigMs("mcp.discovery_timeout", DEFAULT_DISCOVERY_TIMEOUT_S)),
      ]);
      if (result === TIMEOUT) {
        health = "discovery-timed-out";
        lastErrorMessage = "tool discovery exceeded configured timeout";
        log.error(
          {
            event: "mcp_discovery_timed_out",
            url: cfg.url,
            transport: cfg.type,
          },
          "MCP tool discovery timed out; agent will run without these tools",
        );
        cachedTools = {};
        // SECURITY: prevent resource leak when the connection settles
        // AFTER the race timed out. The MCP transport keeps the
        // socket / SSE handle alive in `result.client` even though
        // nothing else references it — without this cleanup that
        // handle stays open until the peer times out, which can
        // accumulate file descriptors over time. `then` swallows
        // both connect success (close it) and connect failure
        // (handled by connectAndList's own catch).
        connectionPromise
          .then((late) => {
            late.client.close().catch(() => { /* ignore close errors */ });
          })
          .catch(() => { /* connectAndList rejected — nothing to clean up */ });
        return;
      }
      // QUIRK: closed during warmup — release the client we just opened.
      if (closed) {
        try { await result.client.close(); } catch { /* ignore */ }
        return;
      }
      client = result.client;
      cachedTools = wrapTools(result.tools, result.client, log);
      health = "ready";
      log.info(
        {
          event: "mcp_discovery_ready",
          url: cfg.url,
          transport: cfg.type,
          toolCount: result.tools.length,
        },
        "MCP tool discovery completed",
      );
    } catch (err) {
      health = "discovery-failed";
      lastErrorMessage = err instanceof Error ? err.message : String(err);
      log.error(
        {
          event: "mcp_discovery_failed",
          url: cfg.url,
          transport: cfg.type,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : { name: "Unknown", message: String(err) },
        },
        "MCP tool discovery failed; agent will run without these tools",
      );
      cachedTools = {};
    }
  })();

  return {
    // QUIRK: `as never` bridges the structurally-identical-but-
    // nominally-different `ToolSet` types between `ai` versions.
    async tools() {
      if (cachedTools) return cachedTools as never;
      await warmup;
      return (cachedTools ?? {}) as never;
    },
    async close(): Promise<void> {
      closed = true;
      if (client) {
        try {
          await client.close();
        } catch {
          /* ignore close errors */
        }
        client = null;
      }
    },
    get label(): string {
      return cfg.label;
    },
    get health(): GracefulMcpProviderHealth {
      return health;
    },
    get lastErrorMessage(): string | null {
      return lastErrorMessage;
    },
  };
}

// Internals

const TIMEOUT = Symbol("mcp-warmup-timeout");

/** Subset of `client.listTools()` result we actually use. */
interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Connect and list. Pure procedural connect + listTools using the
 * official SDK — no protocolVersion mutation, no proxy layer.
 */
async function connectAndList(
  cfg: GracefulMcpProviderConfig,
): Promise<{ client: Client; tools: readonly RawMcpTool[] }> {
  const transport =
    cfg.type === "sse"
      ? new SSEClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        })
      : new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });

  const client = new Client({ name: "nango-builtin-runtime", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    return { client, tools: (result.tools ?? []) as readonly RawMcpTool[] };
  } catch (err) {
    // Discovery threw after connect — close the socket we just opened.
    try { await client.close(); } catch { /* ignore */ }
    throw err;
  }
}

function timeout(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms));
}

/**
 * Convert each MCP tool definition into a Vercel AI SDK `dynamicTool`
 * — the shape CopilotKit's `mcpClients` flow spreads into
 * `streamText.tools`. Uses `dynamicTool` (not `tool`) because the
 * parameters schema is runtime JSON Schema from the MCP server, not
 * a compile-time Zod / Standard Schema.
 *
 * Each tool's `execute` invokes the official SDK's `client.callTool`
 * and is wrapped by {@link wrapToolExecute} (shared with Class B/C
 * server tools) so a transport-level throw becomes a structured
 * `ToolExecutionFailure` instead of an AI SDK `tool-error` part that
 * CopilotKit would drop on the way to the browser. The `label` is
 * already carried in the child-logger context, so it doesn't need to
 * be threaded through the failure envelope.
 */
function wrapTools(
  rawTools: readonly RawMcpTool[],
  client: Client,
  log: ReturnType<typeof childLogger>,
): RawToolSet {
  const wrapped: RawToolSet = {};
  for (const raw of rawTools) {
    if (!raw?.name) continue;
    const baseTool = dynamicTool({
      description: raw.description ?? "",
      inputSchema: jsonSchema({
        ...(raw.inputSchema ?? { type: "object", properties: {} }),
        // SECURITY: MCP servers occasionally allow undeclared args;
        // force strict so the LLM only sends what the schema permits.
        additionalProperties: false,
      } as Record<string, unknown>),
      execute: async (args: unknown) => {
        const result = await client.callTool({
          name: raw.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });

        return normalizeAndDeduplicateMcpResult(result, { parseForUi: false });
      },
    });
    wrapped[raw.name] = wrapToolExecute(baseTool, raw.name, log, "mcp_tool_call_failed");
  }
  return wrapped;
}
