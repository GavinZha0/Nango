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
import { getConfigBoolean, getConfigNumber } from "@/lib/config";

import { defineToolMiddleware } from "./compose";
import { loopDetectionMiddleware } from "./loop-detection";
import { toolSafetyPolicyMiddleware } from "./tool-safety";
import { evaluateToolRisk } from "./risk-registry";
import { toolResultSanitizationMiddleware } from "./sanitizer";
import { getGuardrailConfigCache, recordInterceptionLog } from "./guardrail-service";
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
          // Log the Headless Deny event
          if (ctx.runId) {
            await recordInterceptionLog({
              runId: ctx.runId,
              userId: ctx.userId,
              stage: "input",
              category: "tool_risk",
              policyName: "G20 - Headless Deny",
              policyType: "builtin_rule",
              toolName: call.toolName,
              action: "block",
              severity: risk.riskLevel === "critical" || risk.riskLevel === "high" ? risk.riskLevel : "medium",
              payload: { reason: "Tool requires manual approval but was executed headlessly", riskLevel: risk.riskLevel },
            });
          }

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
 * Includes HITL approval (order 35-40), error handling (order 50),
 * result sanitization (order 55), loop detection (order 60),
 * and input safety policy (order 35).
 *
 * Middlewares are conditionally added based on guardrail.* config toggles.
 */
export function buildServerToolMiddlewares(opts: {
  approvalMode: "always" | "auto" | "never";
  exemptTools: ReadonlySet<string>;
  log?: ReturnType<typeof childLogger>;
  loopThreshold?: number;
}): ToolMiddleware[] {
  const middlewares: ToolMiddleware[] = [];

  // Order 35: Input safety policy (if enabled and rules exist)
  const inputSafetyEnabled = getConfigBoolean("guardrail.input_safety.enabled", true);
  if (inputSafetyEnabled) {
    const cache = getGuardrailConfigCache();
    const inputRules = cache.safetyPolicies.filter(
      (p) => p.enabled && (p.scope === "input" || p.scope === "global")
    ) as import("./tool-safety").SafetyPolicyRule[];
    if (inputRules.length > 0) {
      middlewares.push(toolSafetyPolicyMiddleware(inputRules));
    }
  }

  // Order 40: HITL approval gate (always present)
  middlewares.push(
    toolApprovalMiddleware({ approvalMode: opts.approvalMode, exemptTools: opts.exemptTools })
  );

  // Order 50: Error handling (always present)
  middlewares.push(toolErrorHandlingMiddleware(opts.log, "server_tool_failed"));

  // Order 55: Result sanitization (if enabled)
  const sanitizationEnabled = getConfigBoolean("guardrail.result_sanitization.enabled", true);
  if (sanitizationEnabled) {
    middlewares.push(toolResultSanitizationMiddleware());
  }

  // Order 60: Loop detection (if enabled)
  const loopDetectionEnabled = getConfigBoolean("guardrail.loop_detection.enabled", true);
  if (loopDetectionEnabled) {
    const threshold = getConfigNumber("guardrail.loop_detection.threshold", 3);
    middlewares.push(loopDetectionMiddleware(threshold));
  }

  return middlewares;
}
