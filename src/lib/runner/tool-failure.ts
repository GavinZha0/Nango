/**
 * Generic tool-execution failure envelope + the wrapper that produces it.
 *
 * When a tool's `execute` throws, the AI SDK emits `tool-error` which
 * CopilotKit 1.56's AISDK converter drops — the browser never sees
 * `TOOL_CALL_RESULT` and the UI hangs in "loading". Wrapping converts
 * throws into a success-shaped `{ isError: true, ... }` payload so the
 * AI SDK sees `tool-result` and the LLM gets a recoverable signal.
 *
 * See docs/runner.md and docs/diagrams/tool-lifecycle.html.
 */

import "server-only";

import type { childLogger } from "@/lib/observability/logger";

/**
 * Shape returned to the LLM when a tool's `execute` throws.
 * `isError: true` mirrors MCP's CallToolResult.isError convention so
 * MCP and server-side tool failures share one signal.
 */
export interface ToolExecutionFailure {
  readonly isError: true;
  readonly message: string;
  readonly toolName: string;
}

/**
 * System-prompt block appended whenever an agent has at least one tool
 * wrapped through {@link wrapToolExecute}. Single source of truth —
 * both Class B/C dispatch and MCP wrapping rely on it. Update wording
 * here, never inline at call sites.
 */
export const ERROR_POLICY_BLOCK = `## Tool error handling

If a tool result contains \`isError: true\`, the tool failed unexpectedly. Do not retry the same call with identical arguments. Either:
- pick a different tool that can achieve the same goal, or
- continue without the tool and tell the user what went wrong.`;

/** Marker added to wrapped tools so {@link wrapToolExecute} is idempotent. */
const WRAPPED_MARKER = "__nangoWrapped" as const;

interface PossiblyWrapped {
  execute?: (...args: unknown[]) => unknown;
  [WRAPPED_MARKER]?: true;
}

/**
 * Wrap a tool-shaped object so any throw from its `execute` becomes a
 * {@link ToolExecutionFailure} return value. Idempotent. Non-tool
 * inputs are returned unchanged.
 *
 * ASSUMPTION: `tool` is a POJO. The spread is a SHALLOW COPY — class
 * instances would lose their prototype chain. Use `Object.create` +
 * `Object.assign` if class-based tools are ever introduced.
 */
export function wrapToolExecute<T>(
  tool: T,
  toolName: string,
  log?: ReturnType<typeof childLogger>,
  logEvent: string = "tool_execute_failed",
): T {
  if (!tool || typeof tool !== "object") return tool;
  const t = tool as PossiblyWrapped;
  if (typeof t.execute !== "function") return tool;
  if (t[WRAPPED_MARKER]) return tool;
  const original = t.execute;

  const wrapped: PossiblyWrapped = {
    ...(tool as object),
    [WRAPPED_MARKER]: true,
    execute: async (...args: unknown[]) => {
      try {
        return await original.apply(tool, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (log) {
          log.warn(
            {
              event: logEvent,
              toolName,
              err:
                err instanceof Error
                  ? { name: err.name, message: err.message, stack: err.stack }
                  : { name: "Unknown", message: String(err) },
            },
            "tool execute threw; returning structured isError result",
          );
        }
        const failure: ToolExecutionFailure = {
          isError: true,
          message,
          toolName,
        };
        return failure;
      }
    },
  };
  return wrapped as T;
}
