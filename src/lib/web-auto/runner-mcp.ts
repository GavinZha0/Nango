/**
 * Web Auto — MCP execution layer (Playwright via browser_run_code_unsafe).
 *
 * Reuses verification's MCP execution pattern but adapted for Web Auto:
 * - Fixed tool name: browser_run_code_unsafe
 * - Input: scriptContent from case
 * - Output: structured JSON for assertion layers
 *
 * NEVER throws — every error surface is mapped into the structured outcome.
 */

import "server-only";

import { composePipelinedMcpProvider } from "@/lib/agent-pipeline/compose";
import { toolErrorHandlingMiddleware } from "@/lib/agent-pipeline/middlewares";
import { mcpProviderPool } from "@/lib/mcp";
import { normalizeMcpToolResult } from "@/lib/mcp/tool-result-utils";
import {
  TOOL_FAILURE_CAUSE,
  type ToolFailureCause,
} from "@/lib/runner/tool-failure";
import { classifyMcpError } from "@/lib/verification/error-source";
import type { ErrorEnvelope } from "@/lib/verification/types";

import type { NormalizedWebAutoOutput } from "./types";

export interface RunWebAutoMcpInput {
  mcpServerId: string;
  /** Playwright script content to execute */
  scriptContent: string;
  /** Suite-level variables for template substitution */
  variables?: Record<string, unknown>;
}

/**
 * Execute Playwright script via browser_run_code_unsafe tool.
 *
 * Decision table for the returned `status`:
 *
 *   tool throw (transport / mcphub / upstream 4xx-5xx) → "errored"
 *   tool returned `{isError: true}` (MCP server-side)  → "failed"
 *   tool returned successfully                         → continue to assertion layers
 *
 * The `errored` vs `failed` split matches verification's error precedence:
 * infra problems escalate above pure assertion mismatches.
 */
export async function runWebAutoMcp(
  input: RunWebAutoMcpInput,
): Promise<{
  status: "errored" | "failed" | "success";
  executionOutput: unknown;
  error: ErrorEnvelope | null;
  durationMs: number;
}> {
  const startedAt: number = Date.now();

  // Build tool input for browser_run_code_unsafe
  const toolInput = {
    code: input.scriptContent,
    // Add variables as context for the script
    ...(input.variables ? { context: input.variables } : {}),
  };

  // Borrow → tools → execute. All wrapped in try/finally so the
  // refcount is always released, even on internal throws.
  let provider: Awaited<ReturnType<typeof mcpProviderPool.borrow>> | null = null;
  try {
    provider = await mcpProviderPool.borrow(input.mcpServerId);
  } catch (err) {
    return {
      status: "errored",
      executionOutput: null,
      error: classifyMcpError(err),
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const pipelinedProvider = composePipelinedMcpProvider(
      provider,
      [toolErrorHandlingMiddleware(undefined, "web_auto_mcp_failed")],
      { userId: "", isHeadless: true, metadata: {} },
    );
    const tools: Record<string, unknown> = (await pipelinedProvider.tools()) as Record<
      string,
      unknown
    >;
    
    // Use fixed tool name for Playwright execution
    const toolName = "browser_run_code_unsafe";
    const tool = tools[toolName] as
      | {
          execute?: (args: Record<string, unknown>) => Promise<unknown>;
        }
      | undefined;

    if (!tool || typeof tool.execute !== "function") {
      return {
        status: "errored",
        executionOutput: null,
        error: {
          source: "internal",
          message: `Playwright tool not found on server: ${toolName}`,
          details: { mcpServerId: input.mcpServerId, toolName },
        },
        durationMs: Date.now() - startedAt,
      };
    }

    // Execute the Playwright script
    let raw: unknown;
    try {
      const executed = await tool.execute(toolInput);
      raw = normalizeMcpToolResult(executed, { parseForUi: true });
    } catch (err) {
      // wrapToolExecute should have caught this, but defend in depth.
      return {
        status: "errored",
        executionOutput: null,
        error: classifyMcpError(err),
        durationMs: Date.now() - startedAt,
      };
    }

    // Inspect the result shape.
    const wrapperFailure = isWrapperFailure(raw);
    if (wrapperFailure) {
      // Rebuild a synthetic Error for error classification
      const cause = readToolFailureCause(raw);
      const synthetic = new Error(wrapperFailure.message);
      if (cause) {
        if (cause.name) synthetic.name = cause.name;
        if (cause.stack) synthetic.stack = cause.stack;
        // Mirror the fields `classifyMcpError` reads off the Error.
        const aug = synthetic as unknown as Record<string, unknown>;
        if (cause.code !== undefined) aug.code = cause.code;
        if (cause.httpStatus !== undefined) aug.status = cause.httpStatus;
        if (cause.headers !== undefined) aug.headers = cause.headers;
        if (cause.address !== undefined) aug.address = cause.address;
        if (cause.port !== undefined) aug.port = cause.port;
      }
      return {
        status: "errored",
        executionOutput: null,
        error: classifyMcpError(synthetic),
        durationMs: Date.now() - startedAt,
      };
    }

    const mcpIsError = isMcpIsError(raw);
    if (mcpIsError) {
      // MCP tool itself signalled an error
      return {
        status: "failed",
        executionOutput: raw,
        error: {
          source: "upstream",
          message: extractMcpErrorText(raw) ?? "Playwright execution failed",
          details: { mcpIsError: true },
        },
        durationMs: Date.now() - startedAt,
      };
    }

    // Successful execution - parse structured result for assertion layers
    const structuredOutput = parsePlaywrightOutput(raw);

    return {
      status: "success",
      executionOutput: structuredOutput,
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (provider) {
      mcpProviderPool.release(input.mcpServerId, provider);
    }
  }
}

// --- helpers ---------------------------------------------------------------

/** Read the in-process classification metadata that `wrapToolExecute`
 *  stashed on the failure object via the {@link TOOL_FAILURE_CAUSE}
 *  symbol. */
function readToolFailureCause(raw: unknown): ToolFailureCause | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<typeof TOOL_FAILURE_CAUSE, unknown>)[
    TOOL_FAILURE_CAUSE
  ];
  if (!v || typeof v !== "object") return null;
  return v as ToolFailureCause;
}

/** wrapToolExecute returns `{ isError: true, message, toolName }` —
 *  three-field POJO with NO `content` array. That's how we tell it
 *  apart from a real MCP CallToolResult. */
function isWrapperFailure(
  raw: unknown,
): { message: string; toolName: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.isError !== true) return null;
  if (Array.isArray(r.content)) return null; // MCP shape
  if (typeof r.message !== "string" || typeof r.toolName !== "string") return null;
  return { message: r.message, toolName: r.toolName };
}

/** MCP CallToolResult.isError convention: the tool ran but signalled
 *  a logical error. Result still has a `content` array. */
function isMcpIsError(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return r.isError === true && Array.isArray(r.content);
}

function extractMcpErrorText(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { content?: unknown };
  if (!Array.isArray(r.content)) return null;
  for (const part of r.content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return null;
}

/**
 * Extract clean structured output from Playwright MCP tool (browser_run_code_unsafe).
 * Handles the Markdown envelope (### Result ... ### Ran Playwright code ... ### Page ...)
 */
export function parsePlaywrightOutput(raw: unknown): unknown {
  if (!raw || (typeof raw !== "object" && typeof raw !== "string")) return raw;

  // Extract raw text from MCP CallToolResult format
  let text = "";
  if (
    typeof raw === "object" &&
    raw !== null &&
    "content" in raw &&
    Array.isArray((raw as { content?: unknown[] }).content)
  ) {
    for (const part of (raw as { content: unknown[] }).content) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type: string }).type === "text" &&
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
      ) {
        text += (part as { text: string }).text;
      }
    }
  } else if (typeof raw === "string") {
    text = raw;
  }

  if (!text) return raw;

  // Check for ### Result section
  const resultMatch = text.match(
    /###\s*Result\s*\n([\s\S]*?)(?=(?:###\s*Ran Playwright code|###\s*Page|###\s*Events|$))/i,
  );

  if (resultMatch && resultMatch[1] !== undefined) {
    let resultRaw = resultMatch[1].trim();

    // Strip markdown code block markers if present (e.g. ```json ... ``` or ``` ...)
    if (resultRaw.startsWith("```json")) {
      resultRaw = resultRaw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    } else if (resultRaw.startsWith("```")) {
      resultRaw = resultRaw.replace(/^```\s*/, "").replace(/```$/, "").trim();
    }

    let parsedResult: unknown = resultRaw;
    try {
      parsedResult = JSON.parse(resultRaw);
    } catch {
      // Keep as string if not parseable JSON
    }

    // Extract optional page metadata
    let pageMeta: { url?: string; title?: string; console?: string } | undefined;
    const pageMatch = text.match(
      /###\s*Page\s*\n([\s\S]*?)(?=(?:###\s*Events|$))/i,
    );
    if (pageMatch && pageMatch[1]) {
      const pageText = pageMatch[1];
      const urlMatch = pageText.match(/-\s*Page URL:\s*(.*)/i);
      const titleMatch = pageText.match(/-\s*Page Title:\s*(.*)/i);
      const consoleMatch = pageText.match(/-\s*Console:\s*(.*)/i);

      if (urlMatch || titleMatch || consoleMatch) {
        pageMeta = {
          url: urlMatch ? urlMatch[1].trim() : undefined,
          title: titleMatch ? titleMatch[1].trim() : undefined,
          console: consoleMatch ? consoleMatch[1].trim() : undefined,
        };
      }
    }

    const structured: NormalizedWebAutoOutput = {
      result: parsedResult,
      ...(pageMeta ? { page: pageMeta } : {}),
    };

    return structured;
  }

  // Fallback: try parsing whole text as JSON if it looks like JSON
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return { result: JSON.parse(trimmed) };
    } catch {
      // ignore
    }
  }

  return raw;
}
