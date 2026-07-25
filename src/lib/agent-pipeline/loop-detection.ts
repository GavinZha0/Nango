/**
 * Agent pipeline — G11 Loop Detection Middleware.
 *
 * Prevents runaway token consumption caused by an LLM calling the exact same
 * tool with identical arguments in a repetitive loop.
 *
 * See docs/architecture-improvements.md "P1 — Safety Guardrails".
 */

import "server-only";

import crypto from "crypto";

import { defineToolMiddleware } from "./compose";
import type { ToolMiddleware } from "./types";

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
}

/**
 * Stable JSON stringify that sorts object keys to ensure consistent hashing
 * for semantically identical objects regardless of key order.
 */
function stableStringify(obj: unknown): string {
  if (obj === undefined) return "undefined";
  if (obj === null) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);

  if (Array.isArray(obj)) {
    return `[${obj.map(item => stableStringify(item)).join(",")}]`;
  }

  const sortedKeys = Object.keys(obj as object).sort();
  const pairs = sortedKeys.map(k => {
    const val = (obj as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${stableStringify(val)}`;
  });

  return `{${pairs.join(",")}}`;
}

function computeArgsHash(toolName: string, args: unknown): string {
  const str = `${toolName}:${stableStringify(args ?? {})}`;
  return crypto.createHash("md5").update(str).digest("hex");
}

/**
 * Order 60 — Around middleware that tracks in-memory tool invocation hashes
 * on `ctx.metadata`. Short-circuits when the last `threshold` calls are identical.
 */
export function loopDetectionMiddleware(threshold = 3): ToolMiddleware {
  return defineToolMiddleware({
    name: "loop-detection",
    order: 60,
    beforeToolCall: async (ctx, call) => {
      // In-memory run-scoped history on ctx.metadata
      const historyKey = "__toolCallHistory";
      if (!Array.isArray(ctx.metadata[historyKey])) {
        ctx.metadata[historyKey] = [];
      }
      const history = ctx.metadata[historyKey] as ToolCallRecord[];

      const currentHash = computeArgsHash(call.toolName, call.args);

      // Check if last (threshold - 1) entries match current call
      if (history.length >= threshold - 1) {
        const recentMatches = history
          .slice(-(threshold - 1))
          .every((rec) => rec.toolName === call.toolName && rec.argsHash === currentHash);

        if (recentMatches) {
          return {
            action: "block",
            result: {
              isError: true,
              message: `Loop detected: tool '${call.toolName}' called ${threshold} times with identical arguments. Please change your approach or try a different tool.`,
            },
          };
        }
      }

      // Record this call with memory leak prevention
      const maxHistoryLength = threshold * 10;
      if (history.length >= maxHistoryLength) {
        history.shift(); // Remove oldest entry to prevent unbounded growth
      }
      history.push({ toolName: call.toolName, argsHash: currentHash });
      return { action: "pass" };
    },
  });
}
