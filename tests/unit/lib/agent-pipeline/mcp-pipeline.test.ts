import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  composePipelinedMcpProvider,
  defineToolMiddleware,
} from "@/lib/agent-pipeline/compose";
import type { MiddlewareContext, ToolMiddleware } from "@/lib/agent-pipeline/types";
import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";

const ctx: MiddlewareContext = {
  runId: "run-123",
  userId: "user-456",
  isHeadless: false,
  metadata: {},
};

function createFakeMcpProvider(toolsMap: Record<string, (args: unknown) => Promise<unknown>>): GracefulMcpProvider {
  return {
    label: "fake-mcp",
    health: "ready",
    lastErrorMessage: null,
    async tools() {
      const result: Record<string, unknown> = {};
      for (const [name, fn] of Object.entries(toolsMap)) {
        result[name] = {
          name,
          description: `fake tool ${name}`,
          execute: fn,
        };
      }
      return result as never;
    },
    async close() {
      /* noop */
    },
  };
}

describe("composePipelinedMcpProvider", () => {
  it("wraps all tools returned by provider.tools() with the pipeline", async () => {
    const executed = vi.fn(async () => "mcp-result");
    const provider = createFakeMcpProvider({ test_mcp_tool: executed });

    const log: string[] = [];
    const mw: ToolMiddleware = {
      name: "mw1",
      order: 10,
      wrapToolCall: async (_c, call, next) => {
        log.push(`in:${call.toolName}`);
        const res = await next(call);
        log.push(`out:${call.toolName}`);
        return res;
      },
    };

    const pipelined = composePipelinedMcpProvider(provider, [mw], ctx);
    const tools = (await pipelined.tools()) as Record<string, { execute?: (args: unknown) => Promise<unknown> }>;

    expect(tools.test_mcp_tool).toBeDefined();
    const res = await tools.test_mcp_tool.execute!({ param: 1 });

    expect(res).toBe("mcp-result");
    expect(executed).toHaveBeenCalledWith({ param: 1 });
    expect(log).toEqual(["in:test_mcp_tool", "out:test_mcp_tool"]);
  });

  it("allows middleware to short-circuit (block) an MCP tool call", async () => {
    const executed = vi.fn(async () => "should-not-be-called");
    const provider = createFakeMcpProvider({ dangerous_mcp_tool: executed });

    const blockMw = defineToolMiddleware({
      name: "blocker",
      order: 40,
      beforeToolCall: () => ({ action: "block", result: { isError: true, message: "Blocked by policy" } }),
    });

    const pipelined = composePipelinedMcpProvider(provider, [blockMw], ctx);
    const tools = (await pipelined.tools()) as Record<string, { execute?: (args: unknown) => Promise<unknown> }>;

    const res = await tools.dangerous_mcp_tool.execute!({});
    expect(res).toEqual({ isError: true, message: "Blocked by policy" });
    expect(executed).not.toHaveBeenCalled();
  });

  it("catches MCP tool throws using an error-handling middleware", async () => {
    const provider = createFakeMcpProvider({
      failing_tool: async () => {
        throw new Error("MCP Transport Connection Lost");
      },
    });

    const errMw = defineToolMiddleware({
      name: "err-handler",
      order: 50,
      wrapToolCall: async (_c, call, next) => {
        try {
          return await next(call);
        } catch (e) {
          return { isError: true, message: String(e), toolName: call.toolName };
        }
      },
    });

    const pipelined = composePipelinedMcpProvider(provider, [errMw], ctx);
    const tools = (await pipelined.tools()) as Record<string, { execute?: (args: unknown) => Promise<unknown> }>;

    const res = await tools.failing_tool.execute!({});
    expect(res).toEqual({
      isError: true,
      message: "Error: MCP Transport Connection Lost",
      toolName: "failing_tool",
    });
  });

  it("is idempotent and does not double-wrap already pipelined tools", async () => {
    const executed = vi.fn(async () => "ok");
    const provider = createFakeMcpProvider({ tool_a: executed });

    const mw = defineToolMiddleware({
      name: "m",
      order: 10,
      beforeToolCall: () => ({ action: "pass" }),
    });

    const pipelinedOnce = composePipelinedMcpProvider(provider, [mw], ctx);
    const pipelinedTwice = composePipelinedMcpProvider(pipelinedOnce, [mw], ctx);

    const tools = (await pipelinedTwice.tools()) as Record<string, { execute?: (args: unknown) => Promise<unknown> }>;
    const res = await tools.tool_a.execute!({});

    expect(res).toBe("ok");
    expect(executed).toHaveBeenCalledTimes(1);
  });
});
