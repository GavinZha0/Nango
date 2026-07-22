/**
 * Agent pipeline — the N1-A tool middleware set.
 *
 * Behavior-preserving extraction of the two decorators previously applied
 * ad-hoc in `dispatch/builtin.ts`:
 *   order 40  ToolApprovalMiddleware   (← wrapToolApproval, via runToolApprovalGate)
 *   order 50  ToolErrorHandlingMiddleware (← wrapToolExecute, via toToolFailure)
 *
 * Lower order = outer, so approval gates BEFORE error-handling wraps the
 * execute — identical nesting to the previous `wrapToolApproval(wrapToolExecute(t))`.
 */

import "server-only";

import type { childLogger } from "@/lib/observability/logger";
import { toToolFailure } from "@/lib/runner/tool-failure";
import { runToolApprovalGate } from "@/lib/runner/tool-approval";

import { defineToolMiddleware } from "./compose";
import { loopDetectionMiddleware } from "./loop-detection";
import { evaluateToolRisk } from "./risk-registry";
import { toolResultSanitizationMiddleware } from "./sanitizer";
import type { ToolMiddleware } from "./types";

export { loopDetectionMiddleware } from "./loop-detection";
export { toolResultSanitizationMiddleware } from "./sanitizer";

/** order 50 — innermost: turn any throw into the structured isError envelope. */
export function toolErrorHandlingMiddleware(
  log?: ReturnType<typeof childLogger>,
  logEvent = "server_tool_failed",
): ToolMiddleware {
  return defineToolMiddleware({
    name: "tool-error-handling",
    order: 50,
    wrapToolCall: async (_ctx, call, next) => {
      try {
        return await next(call);
      } catch (err) {
        return toToolFailure(err, call.toolName, log, logEvent);
      }
    },
  });
}

/** order 40 — outer: HITL approval gate. No-op without a runId or for
 *  exempt tools (matches the previous dispatch-site guards). Also enforces
 *  G20 Headless Deny when ctx.isHeadless is true. */
export function toolApprovalMiddleware(opts: {
  approvalMode: "always" | "auto" | "never";
  exemptTools: ReadonlySet<string>;
}): ToolMiddleware {
  return defineToolMiddleware({
    name: "tool-approval",
    order: 40,
    beforeToolCall: async (ctx, call) => {
      if (opts.exemptTools.has(call.toolName)) return { action: "pass" };

      // G20 Headless Deny — immediately reject tools requiring manual approval in no-user runs
      if (ctx.isHeadless) {
        const risk = evaluateToolRisk(call.toolName, call.args);
        if (risk.requiresApproval || !risk.headlessAllowed) {
          return {
            action: "block",
            result: {
              isError: true,
              message: `Headless execution denied for tool requiring manual approval: ${call.toolName}`,
            },
          };
        }
      }

      if (!ctx.runId) return { action: "pass" };
      const gate = await runToolApprovalGate({
        toolName: call.toolName,
        args: call.args,
        toolCallId: call.toolCallId,
        approvalMode: opts.approvalMode,
        runId: ctx.runId,
        userId: ctx.userId,
      });
      return gate.proceed ? { action: "pass" } : { action: "block", result: gate.result };
    },
  });
}

/**
 * The server-tool middleware chain applied in built-in dispatch.
 * Includes HITL approval (order 40), error handling (order 50),
 * result sanitization (order 55), and loop detection (order 60).
 */
export function buildServerToolMiddlewares(opts: {
  approvalMode: "always" | "auto" | "never";
  exemptTools: ReadonlySet<string>;
  log?: ReturnType<typeof childLogger>;
  loopThreshold?: number;
}): ToolMiddleware[] {
  return [
    toolApprovalMiddleware({ approvalMode: opts.approvalMode, exemptTools: opts.exemptTools }),
    toolErrorHandlingMiddleware(opts.log, "server_tool_failed"),
    toolResultSanitizationMiddleware(),
    loopDetectionMiddleware(opts.loopThreshold ?? 3),
  ];
}
