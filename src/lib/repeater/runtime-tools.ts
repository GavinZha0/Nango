/**
 * Server-side `repeat_tool` agent tool.
 *
 * Universal tool for repeating the execution of an MCP or server-side tool at
 * fixed intervals (bounded to 5-60s) until a stop condition is met, maximum
 * count is reached, or timeout occurs.
 *
 * Registered in `BUILTIN_TOOLS` under the `outcomes` category, user-toggleable
 * in `BuiltinAgentEditor`.
 */

import "server-only";

import { z } from "zod";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import { extractMcpStructuredData } from "@/lib/verification/resolve-input";

export const StopConditionSchema = z.object({
  field: z
    .string()
    .optional()
    .describe("Dot-path in the result to inspect (e.g. 'status' or 'data.state')."),
  equals: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .describe("Stop when field strictly equals this value (e.g. 'completed' or 'ready')."),
  not_equals: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .describe("Stop when field is no longer this value (e.g. 'pending' or 'running')."),
  one_of: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Stop when field matches any of these values (e.g. ['completed', 'failed'])."),
  contains: z
    .string()
    .optional()
    .describe("Stop when output text or serialized result contains this substring."),
});

export type StopCondition = z.infer<typeof StopConditionSchema>;

export const RepeatToolInputSchema = z.object({
  tool_name: z
    .string()
    .describe("The name of the tool to execute repeatedly (e.g. 'get_state', 'verify_login')."),
  tool_args: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Arguments to pass to the target tool on each execution."),
  interval_sec: z
    .number()
    .min(5)
    .max(30)
    .default(5)
    .describe("Interval in seconds between executions. Min 5s, max 30s. Default is 5s."),
  initial_delay_sec: z
    .number()
    .min(0)
    .max(60)
    .default(0)
    .describe("Optional initial delay in seconds before the first execution (0-60s, default 0). Use this if you need to wait before starting."),
  timeout_sec: z
    .number()
    .min(5)
    .max(60)
    .default(60)
    .describe("Maximum total duration in seconds for this call. Min 5s, max 60s. Default is 60s."),
  max_count: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe("Optional maximum number of times to execute (1-12). If omitted, runs until condition or timeout."),
  stop_condition: StopConditionSchema.optional().describe(
    "Condition that terminates execution early when satisfied. If omitted, repeats until max_count or timeout.",
  ),
});

export type RepeatToolInput = z.infer<typeof RepeatToolInputSchema>;

export interface RepeatToolSuccess {
  ok: true;
  status: "completed" | "timeout";
  result: unknown;
}

export interface RepeatToolError {
  ok: false;
  status: "error";
  error: string;
  message: string;
  result?: unknown;
}

export type RepeatToolResult = RepeatToolSuccess | RepeatToolError;

export interface ToolCallable {
  execute?: (args: unknown) => Promise<unknown>;
}

export interface BuildRepeatToolOptions {
  /** Resolver to find and invoke a tool in the active agent's toolkit. */
  getTool: (
    name: string,
  ) => ToolCallable | Promise<ToolCallable | undefined> | undefined;
  /** Optional listing of all available tool names for diagnostic error messages. */
  availableToolNames?: () => string[] | Promise<string[]>;
  /** Optional custom sleep function (used for unit testing with fake timers). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Optional hook to mark the currently polling tool name for downstream loop-detection bypass. */
  setActiveRepeatTool?: (toolName: string | undefined) => void;
}

/**
 * Extract value from an object using a dot-delimited path (e.g. "data.status").
 */
export function getByDotPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate if a target probe result satisfies the specified stop condition.
 */
export function evaluateStopCondition(
  result: unknown,
  condition?: StopCondition,
): boolean {
  if (!condition) return false;

  const hasFieldCheck =
    condition.field !== undefined &&
    (condition.equals !== undefined ||
      condition.not_equals !== undefined ||
      condition.one_of !== undefined);
  const hasContainsCheck = typeof condition.contains === "string";

  if (!hasFieldCheck && !hasContainsCheck) {
    return false;
  }

  // 1. Evaluate field condition if specified
  if (hasFieldCheck && condition.field) {
    const val = getByDotPath(result, condition.field);

    if (condition.equals !== undefined && val !== condition.equals) {
      return false;
    }
    if (condition.not_equals !== undefined && val === condition.not_equals) {
      return false;
    }
    if (condition.one_of !== undefined && !condition.one_of.includes(val as string | number | boolean)) {
      return false;
    }
  }

  // 2. Evaluate substring contains condition if specified
  if (hasContainsCheck && condition.contains) {
    const sub = condition.contains.toLowerCase();
    let haystack = "";
    if (typeof result === "string") {
      haystack = result.toLowerCase();
    } else {
      try {
        haystack = JSON.stringify(result).toLowerCase();
      } catch {
        haystack = String(result).toLowerCase();
      }
    }
    if (!haystack.includes(sub)) {
      return false;
    }
  }

  return true;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the server-side `repeat_tool` tool definition.
 */
export function buildRepeatTool(opts: BuildRepeatToolOptions): ToolDefinition {
  const sleep = opts.sleepFn ?? defaultSleep;

  return defineTool({
    name: "repeat_tool",
    description:
      "Repeat the execution of an existing tool at specified intervals (5-30s) until a stop condition is met, max_count is reached, or timeout occurs (5-60s). Execution timeline: first execution happens immediately (or after initial_delay_sec if specified), subsequent executions wait interval_sec. NOTE: Returns ONLY the final (latest) execution result; does NOT accumulate intermediate outputs. max_count=1 returns immediately after 1 execution without waiting interval_sec.",
    parameters: RepeatToolInputSchema,
    execute: async (args: RepeatToolInput): Promise<RepeatToolResult> => {
      const toolName = args.tool_name?.trim();

      // SECURITY: Prevent recursive self-invocation
      if (!toolName || toolName === "repeat_tool") {
        return {
          ok: false,
          status: "error",
          error: "RECURSION_FORBIDDEN",
          message: "Cannot invoke 'repeat_tool' recursively.",
        };
      }

      // Hard clamp boundaries
      const intervalSec = Math.max(5, Math.min(30, args.interval_sec ?? 5));
      const timeoutSec = Math.max(5, Math.min(60, args.timeout_sec ?? 60));
      const initialDelaySec = Math.max(0, Math.min(60, args.initial_delay_sec ?? 0));
      const intervalMs = intervalSec * 1000;
      const timeoutMs = timeoutSec * 1000;
      const initialDelayMs = initialDelaySec * 1000;
      const maxCount = args.max_count !== undefined ? Math.max(1, Math.min(12, args.max_count)) : undefined;

      const target = await opts.getTool(toolName);
      if (!target || typeof target.execute !== "function") {
        const available = opts.availableToolNames
          ? await opts.availableToolNames()
          : [];
        const availableHint =
          available.length > 0
            ? ` Available tools: ${available.filter((n) => n !== "repeat_tool").join(", ")}`
            : "";
        return {
          ok: false,
          status: "error",
          error: "TOOL_NOT_FOUND",
          message: `Target tool '${toolName}' not found or not callable by this agent.${availableHint}`,
        };
      }

      const startTime = Date.now();
      if (initialDelayMs > 0) {
        if (initialDelayMs >= timeoutMs) {
          return {
            ok: true,
            status: "timeout",
            result: null,
          };
        }
        await sleep(initialDelayMs);
      }

      // QUIRK: Currently only the latest result is retained and returned to conserve token budget
      // and match polling semantics. If sampling workflows need full trajectory history in the future,
      // consider expanding RepeatToolSuccess to optionally include `results: unknown[]`.
      let latestResult: unknown = null;
      let executionCount = 0;

      while (true) {
        executionCount++;
        let rawResult: unknown;
        // Mark target tool for loop-detection middleware exemption during this probe
        opts.setActiveRepeatTool?.(toolName);
        try {
          rawResult = await target.execute(args.tool_args ?? {});
        } catch (err) {
          // CONTRACT: Catch downstream throws and return structured error envelope
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            status: "error",
            error: "TOOL_EXECUTION_FAILED",
            message: `Tool '${toolName}' threw an error during execution: ${errMsg}`,
          };
        } finally {
          // Always reset the active tool marker immediately after execution
          opts.setActiveRepeatTool?.(undefined);
        }

        // Check if downstream tool returned an error envelope (Rule 19 / ok: false)
        if (
          rawResult &&
          typeof rawResult === "object" &&
          (rawResult as { isError?: boolean }).isError === true
        ) {
          const errMsg =
            (rawResult as { message?: string }).message ?? "Tool execution failed";
          return {
            ok: false,
            status: "error",
            error: "TOOL_EXECUTION_FAILED",
            message: `Tool '${toolName}' reported an error: ${errMsg}`,
            result: rawResult,
          };
        }

        // Unwrap standard MCP payload if present so LLM receives clean JSON
        latestResult = extractMcpStructuredData(rawResult);

        // Check stop condition
        if (evaluateStopCondition(latestResult, args.stop_condition)) {
          return {
            ok: true,
            status: "completed",
            result: latestResult,
          };
        }

        // Check if max_count reached
        if (maxCount !== undefined && executionCount >= maxCount) {
          return {
            ok: true,
            status: "completed",
            result: latestResult,
          };
        }

        // Check if the next probe would exceed timeout
        const elapsedMs = Date.now() - startTime;
        if (elapsedMs + intervalMs >= timeoutMs) {
          return {
            ok: true,
            status: "timeout",
            result: latestResult,
          };
        }

        // Wait before next execution
        await sleep(intervalMs);
      }
    },
  });
}
