/**
 * Agent pipeline — compose ordered tool middlewares into one decorator.
 *
 * See docs/architecture-improvements.md "P0 — Agent Middleware Pipeline".
 */

import "server-only";

import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";
import type {
  MiddlewareContext,
  ToolCall,
  ToolMiddleware,
  ToolMiddlewareSpec,
  ToolNext,
} from "./types";

/** Idempotency marker — distinct from tool-failure's `__nangoWrapped`
 *  (MCP path) so the two never double-wrap in the N1-A transition. */
const PIPELINED_MARKER = "__nangoPipelined" as const;

interface ToolLike {
  name: string;
  execute?: (...args: unknown[]) => unknown;
  [PIPELINED_MARKER]?: true;
}

/**
 * Normalize a {@link ToolMiddlewareSpec} into a {@link ToolMiddleware}.
 * `wrapToolCall` wins when present; otherwise the before/after hooks are
 * folded into a `wrapToolCall`.
 */
export function defineToolMiddleware(spec: ToolMiddlewareSpec): ToolMiddleware {
  if (spec.wrapToolCall) {
    return { name: spec.name, order: spec.order, wrapToolCall: spec.wrapToolCall };
  }
  const { beforeToolCall, afterToolResult } = spec;
  return {
    name: spec.name,
    order: spec.order,
    wrapToolCall: async (ctx, call, next) => {
      if (beforeToolCall) {
        const decision = await beforeToolCall(ctx, call);
        if (decision.action === "block") return decision.result;
      }
      const result = await next(call);
      return afterToolResult ? afterToolResult(ctx, call, result) : result;
    },
  };
}

/**
 * Build a `wrap(tool)` decorator from an ordered middleware list + ctx.
 * Replaces the tool's `execute` with the composed chain (outer→inner by
 * ascending `order`). Idempotent; non-tool inputs pass through unchanged.
 *
 * NOTE (N1-A): the innermost `next` invokes the original execute with the
 * ORIGINAL variadic args (preserving the AI SDK calling convention), so
 * middlewares can inspect `call.args` but cannot yet mutate the args the
 * tool receives. Arg rewriting is a later enhancement.
 */
export function composeToolPipeline(
  middlewares: readonly ToolMiddleware[],
  ctx: MiddlewareContext,
): <T extends ToolLike>(tool: T) => T {
  const ordered = [...middlewares].sort((a, b) => a.order - b.order);

  return function wrap<T extends ToolLike>(tool: T): T {
    if (!tool || typeof tool !== "object") return tool;
    if (typeof tool.execute !== "function") return tool;
    if (tool[PIPELINED_MARKER]) return tool;

    const original = tool.execute.bind(tool);
    const toolName = tool.name;

    const wrappedExecute = async (...rawArgs: unknown[]): Promise<unknown> => {
      const call: ToolCall = {
        toolName,
        args: rawArgs[0],
        toolCallId: (rawArgs[1] as { toolCallId?: string } | undefined)?.toolCallId,
      };
      // Innermost continuation → original execute with the original args.
      const base: ToolNext = async () => original(...rawArgs);
      // Fold middlewares inner→outer so `ordered[0]` runs first inbound.
      let next: ToolNext = base;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const mw = ordered[i];
        const downstream = next;
        next = (c) => mw.wrapToolCall(ctx, c, downstream);
      }
      return next(call);
    };

    return {
      ...(tool as object),
      [PIPELINED_MARKER]: true,
      execute: wrappedExecute,
    } as T;
  };
}

/**
 * Wrap a {@link GracefulMcpProvider} so every tool returned by its `tools()`
 * method is passed through {@link composeToolPipeline}.
 */
export function composePipelinedMcpProvider(
  provider: GracefulMcpProvider,
  middlewares: readonly ToolMiddleware[],
  ctx: MiddlewareContext,
): GracefulMcpProvider {
  const wrap = composeToolPipeline(middlewares, ctx);
  return {
    ...provider,
    async tools() {
      const rawTools = (await provider.tools()) as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [name, tool] of Object.entries(rawTools)) {
        result[name] = wrap(tool as ToolLike);
      }
      return result as never;
    },
  };
}

