import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { composeToolPipeline, defineToolMiddleware } from "@/lib/agent-pipeline/compose";
import type { MiddlewareContext, ToolCall, ToolMiddleware } from "@/lib/agent-pipeline/types";

const ctx: MiddlewareContext = { userId: "u", isHeadless: false, metadata: {} };

/** Around-style middleware that records inbound/outbound order. */
function recordingMw(name: string, order: number, log: string[]): ToolMiddleware {
  return {
    name,
    order,
    wrapToolCall: async (_ctx, call, next) => {
      log.push(`>${name}`);
      const r = await next(call);
      log.push(`<${name}`);
      return r;
    },
  };
}

describe("composeToolPipeline — ordering", () => {
  it("runs lower-order middleware as the OUTER wrapper", async () => {
    const log: string[] = [];
    const wrap = composeToolPipeline(
      [recordingMw("B", 50, log), recordingMw("A", 40, log)],
      ctx,
    );
    const wrapped = wrap({ name: "t", execute: async () => "ok" });
    const res = await wrapped.execute!();
    expect(res).toBe("ok");
    // A(40) outer, B(50) inner → A wraps B wraps tool.
    expect(log).toEqual([">A", ">B", "<B", "<A"]);
  });
});

describe("defineToolMiddleware — before/after sugar", () => {
  it("afterToolResult transforms the result; beforeToolCall pass executes", async () => {
    const mw = defineToolMiddleware({
      name: "x",
      order: 10,
      beforeToolCall: () => ({ action: "pass" }),
      afterToolResult: (_c, _call, r) => ({ wrapped: r }),
    });
    const wrapped = composeToolPipeline([mw], ctx)({ name: "t", execute: async () => "v" });
    expect(await wrapped.execute!()).toEqual({ wrapped: "v" });
  });

  it("beforeToolCall block short-circuits without executing the tool", async () => {
    const executed = vi.fn(async () => "should-not-run");
    const mw = defineToolMiddleware({
      name: "block",
      order: 10,
      beforeToolCall: () => ({ action: "block", result: { isError: true, message: "no" } }),
    });
    const wrapped = composeToolPipeline([mw], ctx)({ name: "t", execute: executed });
    expect(await wrapped.execute!()).toEqual({ isError: true, message: "no" });
    expect(executed).not.toHaveBeenCalled();
  });
});

describe("composeToolPipeline — around can catch throws", () => {
  it("a wrapToolCall middleware catches the tool's throw", async () => {
    const mw = defineToolMiddleware({
      name: "err",
      order: 50,
      wrapToolCall: async (_c, call, next) => {
        try {
          return await next(call);
        } catch (e) {
          return { isError: true, message: String(e) };
        }
      },
    });
    const wrapped = composeToolPipeline([mw], ctx)({
      name: "t",
      execute: async () => {
        throw new Error("boom");
      },
    });
    expect(await wrapped.execute!()).toEqual({ isError: true, message: "Error: boom" });
  });
});

describe("composeToolPipeline — idempotency & passthrough", () => {
  it("does not double-wrap an already-pipelined tool", async () => {
    const executed = vi.fn(async () => "v");
    const wrap = composeToolPipeline([recordingMw("A", 40, [])], ctx);
    const once = wrap({ name: "t", execute: executed });
    const twice = wrap(once);
    expect(twice).toBe(once);
    await twice.execute!();
    expect(executed).toHaveBeenCalledTimes(1);
  });

  it("returns non-tool inputs unchanged", () => {
    const wrap = composeToolPipeline([], ctx);
    const noExecute = { name: "x" };
    expect(wrap(noExecute)).toBe(noExecute);
  });
});

describe("composeToolPipeline — call shape", () => {
  it("exposes args[0] as call.args and args[1].toolCallId as call.toolCallId", async () => {
    let seen: ToolCall | undefined;
    const mw = defineToolMiddleware({
      name: "peek",
      order: 10,
      beforeToolCall: (_c, call) => {
        seen = call;
        return { action: "pass" };
      },
    });
    const wrapped = composeToolPipeline([mw], ctx)({
      name: "t",
      execute: async (..._args: unknown[]) => "v",
    });
    await wrapped.execute!({ foo: 1 }, { toolCallId: "tc-1" });
    expect(seen?.toolName).toBe("t");
    expect(seen?.args).toEqual({ foo: 1 });
    expect(seen?.toolCallId).toBe("tc-1");
  });
});
