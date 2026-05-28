/**
 * Generic tool-execution failure envelope + the wrapper that produces it.
 *
 * Why this exists: when a tool's `execute` function throws, the AI SDK
 * emits a `tool-error` part on its fullStream. CopilotKit 1.56's AISDK
 * converter has no `case "tool-error"` branch — the part is silently
 * dropped and the browser never receives `TOOL_CALL_RESULT`, leaving
 * the React tool-call UI stuck in "loading". See docs/diagrams/tool-lifecycle.html.
 *
 * Fix: wrap every server-side tool's `execute` in a `try/catch` that
 * converts throws into a structured success-shaped object. The AI SDK
 * sees `tool-result` instead of `tool-error`, CopilotKit forwards
 * `TOOL_CALL_RESULT` to the browser, and the LLM gets a JSON payload
 * with `isError: true` so it can recover gracefully.
 *
 * MCP tools are wrapped at discovery time (see lib/mcp/client-providers.ts);
 * Class B + C server tools are wrapped at dispatch time (see
 * lib/runner/dispatch/builtin.ts).
 */

import "server-only";

import type { childLogger } from "@/lib/observability/logger";

/**
 * The shape returned to the LLM when a tool's `execute` throws.
 *
 * `isError: true` mirrors MCP's CallToolResult.isError convention so
 * the LLM sees a consistent error signal across MCP and server-side
 * tool failures. `message` is the throwable's `.message` (or stringified
 * value); `toolName` lets the LLM disambiguate which tool failed when
 * the call site doesn't already echo the name.
 *
 * Intentionally flat (no nested `error` object, no `code`): there's
 * currently only one failure mode (uncaught throw) so any taxonomy
 * would be premature. If we later need to distinguish (e.g. timeout vs
 * permission denied), add a discriminator field — `isError: true`
 * stays as the primary signal so older consumers keep working.
 */
export interface ToolExecutionFailure {
  readonly isError: true;
  readonly message: string;
  readonly toolName: string;
}

/**
 * System-prompt block appended whenever an agent has at least one tool
 * wrapped through {@link wrapToolExecute}. Tells the LLM how to react
 * when it sees `isError: true` in a tool result — avoids the default
 * "retry the same call" or "try every similar-looking tool" failure
 * modes we observed in production before this block existed.
 *
 * Single source of truth — both Class B/C dispatch and MCP wrapping
 * rely on it. Update the wording here, never inline at call sites.
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
 * {@link ToolExecutionFailure} return value.
 *
 * Idempotent: a tool already wrapped (carrying `__nangoWrapped`) is
 * returned unchanged so double-wrapping at composition boundaries
 * (MCP discovery + Class B/C dispatch) doesn't compound try/catches.
 *
 * Non-tool inputs (null, primitives, objects without `execute`) are
 * returned unchanged so call sites can blanket-map an array without
 * defensive filtering.
 *
 * ASSUMPTION: `tool` is a POJO (plain object literal). Both `defineTool`
 * from `@copilotkit/runtime/v2` and `dynamicTool` from `ai` return
 * literal objects, which is the only currently-supported shape. The
 * spread `{ ...(tool as object), ... }` is a SHALLOW COPY — if a future
 * caller passes a class instance, the prototype chain (methods, getters,
 * setters) will be silently dropped. If we ever need class-based tools,
 * use `Object.create(Object.getPrototypeOf(tool))` + `Object.assign`
 * instead, or attach the new `execute` via `Reflect.set` to preserve
 * the prototype.
 *
 * @param tool      The tool object (anything with an `execute` async fn)
 * @param toolName  Name surfaced in both the failure envelope and the log warning
 * @param log       Optional pino child logger; if omitted, failures are silent
 * @param logEvent  Log `event` tag — defaults to a generic value, MCP passes a
 *                  more specific one so ops can grep separately
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
