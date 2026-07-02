/**
 * Verification — single MCP case execution.
 *
 * Borrows from `mcp/provider-pool`, calls the named tool, evaluates
 * assertions against the FULL payload, classifies failures, and
 * returns a {@link CaseExecutionOutcome}. NEVER throws — every error
 * surface is mapped into the structured outcome shape.
 *
 * MCP cases do NOT go through `entity_run` (a tool call is not an
 * entity dispatch — see docs/verification.md). The orchestrator
 * persists the returned outcome directly via `storage.writeCaseResult`.
 */

import "server-only";

import { mcpProviderPool } from "@/lib/mcp";
import {
  TOOL_FAILURE_CAUSE,
  type ToolFailureCause,
} from "@/lib/runner/tool-failure";

import { runAssertions } from "./assertions";
import { classifyMcpError } from "./error-source";
import type {
  AssertionSpec,
  CaseExecutionOutcome,
  ErrorEnvelope,
} from "./types";

export interface RunMcpCaseInput {
  mcpServerId: string;
  toolName: string;
  input: Record<string, unknown>;
  assertions: readonly AssertionSpec[];
}

/**
 * Execute one MCP case end-to-end.
 *
 * Decision table for the returned `status`:
 *
 *   tool throw (transport / mcphub / upstream 4xx-5xx) → "errored"
 *   tool returned `{isError: true}` (MCP server-side)  → "failed"
 *   tool returned + assertions all pass                 → "passed"
 *   tool returned + some assertion failed               → "failed"
 *   tool returned + empty assertions                    → "passed"
 *
 * The `errored` vs `failed` split matches the docs status precedence:
 * infra problems escalate above pure assertion mismatches.
 */
export async function runMcpCase(
  input: RunMcpCaseInput,
): Promise<CaseExecutionOutcome> {
  const startedAt: number = Date.now();

  // Borrow → tools → execute. All wrapped in try/finally so the
  // refcount is always released, even on internal throws.
  let provider: Awaited<ReturnType<typeof mcpProviderPool.borrow>> | null = null;
  try {
    provider = await mcpProviderPool.borrow(input.mcpServerId);
  } catch (err) {
    return failedOutcome({
      startedAt,
      durationMs: Date.now() - startedAt,
      error: classifyMcpError(err),
    });
  }

  try {
    const tools: Record<string, unknown> = (await provider.tools()) as Record<
      string,
      unknown
    >;
    const tool = tools[input.toolName] as
      | {
          execute?: (args: Record<string, unknown>) => Promise<unknown>;
        }
      | undefined;

    if (!tool || typeof tool.execute !== "function") {
      return failedOutcome({
        startedAt,
        durationMs: Date.now() - startedAt,
        error: {
          source: "internal",
          message: `tool not found on server: ${input.toolName}`,
          details: { mcpServerId: input.mcpServerId, toolName: input.toolName },
        },
      });
    }

    // `tool.execute` is wrapped by `wrapToolExecute` so transport
    // throws become `{isError: true, message, toolName}` instead of
    // throwing. We distinguish that envelope from a genuine MCP
    // CallToolResult.isError by the absence of `content`.
    let raw: unknown;
    try {
      raw = await tool.execute(input.input);
    } catch (err) {
      // wrapToolExecute should have caught this, but defend in depth.
      return failedOutcome({
        startedAt,
        durationMs: Date.now() - startedAt,
        error: classifyMcpError(err),
      });
    }

    // Inspect the result shape.
    const wrapperFailure = isWrapperFailure(raw);
    if (wrapperFailure) {
      // Rebuild a synthetic Error that mimics the ORIGINAL thrown
      // error so `classifyMcpError` can apply its normal heuristics
      // (transport-code → "transport", HTTP 4xx → "upstream", 5xx +
      // mcphub-source header → "mcphub" / "upstream"). Without this,
      // the classifier only sees an Error whose sole field is the
      // message and unconditionally falls through to "internal" —
      // the bug noted in the verification subsystem review.
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
      return failedOutcome({
        startedAt,
        durationMs: Date.now() - startedAt,
        error: classifyMcpError(synthetic),
      });
    }

    const mcpIsError = isMcpIsError(raw);
    const assertionResults = runAssertions(raw, input.assertions);
    const allAssertionsPassed = assertionResults.every((r) => r.ok);
    const passed = !mcpIsError && allAssertionsPassed;

    let topLineError: ErrorEnvelope | null = null;
    if (mcpIsError) {
      // MCP tool itself signalled an error — surface as `upstream`
      // failure with the MCP content text if available.
      topLineError = {
        source: "upstream",
        message: extractMcpErrorText(raw) ?? "MCP tool returned isError",
        details: { mcpIsError: true },
      };
    } else if (!allAssertionsPassed) {
      const firstFail = assertionResults.find((r) => !r.ok);
      if (firstFail) {
        topLineError = {
          source: "assertion",
          message: firstFail.message ?? "assertion failed",
          details: {
            assertionPath: firstFail.path,
            expected: firstFail.expected,
            actual: firstFail.actual,
          },
        };
      }
    }

    return {
      status: passed ? "passed" : "failed",
      resultPayload: raw,
      resultTruncated: false,
      assertionResults,
      error: topLineError,
      startedAt,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (provider) {
      mcpProviderPool.release(input.mcpServerId, provider);
    }
  }
}

// --- helpers ---------------------------------------------------------------

function failedOutcome(args: {
  startedAt: number;
  durationMs: number;
  error: ErrorEnvelope;
}): CaseExecutionOutcome {
  return {
    status: "errored",
    resultPayload: null,
    resultTruncated: false,
    assertionResults: [],
    error: args.error,
    startedAt: args.startedAt,
    durationMs: args.durationMs,
  };
}

/** Read the in-process classification metadata that `wrapToolExecute`
 *  stashed on the failure object via the {@link TOOL_FAILURE_CAUSE}
 *  symbol. Returns `null` when the raw value wasn't produced by
 *  `wrapToolExecute` (e.g. a third-party tool that built the
 *  `{isError, message, toolName}` shape by hand). */
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


