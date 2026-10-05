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

import { composePipelinedMcpProvider } from "@/lib/agent-pipeline/compose";
import { toolErrorHandlingMiddleware } from "@/lib/agent-pipeline/middlewares";
import { mcpProviderPool } from "@/lib/mcp";
import { normalizeMcpToolResult } from "@/lib/mcp/tool-result-utils";
import {
  TOOL_FAILURE_CAUSE,
  type ToolFailureCause,
} from "@/lib/runner/tool-failure";
import { evaluateAssertions, resolveInput } from "@/lib/assertions";
import { findUnresolvedTokens } from "./resolve-input";
import { classifyMcpError } from "./error-source";
import type {
  AssertionSpec,
  AssertionResult,
  CaseExecutionOutcome,
  ErrorEnvelope,
} from "./types";
import type { ToolPrefixRule } from "./tool-name";

export interface RunMcpCaseInput {
  mcpServerId: string;
  toolName: string;
  input: Record<string, unknown>;
  assertions: readonly AssertionSpec[];
  originalToolName?: string;
  serverName?: string;
  rule?: ToolPrefixRule | null;
  caseTimeoutSec?: number | null;
}

/**
 * Execute one MCP case end-to-end.
 *
 * Decision table for the returned `status`:
 *
 *   tool throw (transport / endpoint / connection refused) → "errored"
 *   tool not found on server                             → "errored"
 *   tool returned + user assertions present:
 *     - all assertions pass                              → "passed" (supports negative testing)
 *     - some assertion failed                            → "failed"
 *   tool returned + empty assertions (smoke test):
 *     - tool returned isError: false                     → "passed"
 *     - tool returned isError: true                      → "failed"
 *
 * Infra/transport problems escalate to "errored", while tool output (whether
 * successful or error payload) is evaluated against the user's assertions.
 */
export async function runMcpCase(
  input: RunMcpCaseInput,
  runContext?: Record<string, unknown>,
): Promise<CaseExecutionOutcome> {
  const startedAt: number = Date.now();
  const resolvedInput: Record<string, unknown> = resolveInput(input.input, runContext);

  const effectiveTimeoutSec =
    typeof input.caseTimeoutSec === "number" && input.caseTimeoutSec > 0
      ? input.caseTimeoutSec
      : 60;

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
      resolvedInput,
    });
  }

  try {
    const pipelinedProvider = composePipelinedMcpProvider(
      provider,
      [toolErrorHandlingMiddleware(undefined, "mcp_verification_failed")],
      { userId: "", isHeadless: true, metadata: {} },
    );
    const tools: Record<string, unknown> = (await pipelinedProvider.tools()) as Record<
      string,
      unknown
    >;

    // QUIRK: Discovery may have timed out or failed, resulting in empty cachedTools.
    // Check provider.health BEFORE concluding that the tool itself doesn't exist on the server.
    const graceful = provider as unknown as {
      health?: string;
      lastErrorMessage?: string | null;
    };
    if (graceful.health === "discovery-timed-out") {
      return failedOutcome({
        startedAt,
        durationMs: Date.now() - startedAt,
        error: {
          source: "timeout",
          message:
            graceful.lastErrorMessage
            || `Tool discovery exceeded configured timeout on server "${input.serverName || input.mcpServerId}"`,
          details: { mcpServerId: input.mcpServerId, health: graceful.health },
        },
        resolvedInput,
      });
    }
    if (graceful.health === "discovery-failed") {
      return failedOutcome({
        startedAt,
        durationMs: Date.now() - startedAt,
        error: {
          source: "transport",
          message:
            graceful.lastErrorMessage
            || `Tool discovery failed on server "${input.serverName || input.mcpServerId}"`,
          details: { mcpServerId: input.mcpServerId, health: graceful.health },
        },
        resolvedInput,
      });
    }

    const tool = tools[input.toolName] as
      | {
          execute?: (args: Record<string, unknown>) => Promise<unknown>;
        }
      | undefined;

    if (!tool || typeof tool.execute !== "function") {
      const serverLabel = input.serverName ? ` on server "${input.serverName}"` : "";
      const originalInfo = input.originalToolName
        ? ` (Original toolName: "${input.originalToolName}", Mode: "${input.rule?.mode ?? "none"}")`
        : "";
      return failedOutcome({
        startedAt,
        durationMs: Date.now() - startedAt,
        error: {
          source: "endpoint",
          message: `MCP tool "${input.toolName}" not found${serverLabel}.${originalInfo}`,
          details: {
            mcpServerId: input.mcpServerId,
            toolName: input.toolName,
            originalToolName: input.originalToolName,
            mode: input.rule?.mode ?? "none",
          },
        },
        resolvedInput,
      });
    }

    // `tool.execute` is wrapped by `wrapToolExecute` so transport
    // throws become `{isError: true, message, toolName}` instead of
    // throwing. We distinguish that envelope from a genuine MCP
    // CallToolResult.isError by the absence of `content`.
    let toolDurationMs = 0;
    let raw: unknown;
    const toolStart = performance.now();
    try {
      const executeOpts = { timeoutMs: effectiveTimeoutSec * 1000 };
      const executed = await (
        tool.execute as (
          args: unknown,
          opts?: unknown,
        ) => Promise<unknown>
      )(resolvedInput, executeOpts);
      toolDurationMs = Math.round(performance.now() - toolStart);
      raw = normalizeMcpToolResult(executed, { parseForUi: true });
    } catch (err) {
      toolDurationMs = Math.round(performance.now() - toolStart);
      // wrapToolExecute should have caught this, but defend in depth.
      return failedOutcome({
        startedAt,
        durationMs: toolDurationMs,
        error: classifyMcpError(err),
        resolvedInput,
      });
    }

    // Inspect the result shape.
    const wrapperFailure = isWrapperFailure(raw);
    if (wrapperFailure) {
      const cause = readToolFailureCause(raw);
      const synthetic = new Error(wrapperFailure.message);
      if (cause) {
        if (cause.name) synthetic.name = cause.name;
        if (cause.stack) synthetic.stack = cause.stack;
        const aug = synthetic as unknown as Record<string, unknown>;
        if (cause.code !== undefined) aug.code = cause.code;
        if (cause.httpStatus !== undefined) aug.status = cause.httpStatus;
        if (cause.headers !== undefined) aug.headers = cause.headers;
        if (cause.address !== undefined) aug.address = cause.address;
        if (cause.port !== undefined) aug.port = cause.port;
      }
      const classifiedError = classifyMcpError(synthetic);

      // V1-2: 1. outputSchema violation check — server answered, but payload violates declared schema
      const msgLower = wrapperFailure.message.toLowerCase();
      if (
        msgLower.includes("output validation failed")
        || msgLower.includes("outputschema")
      ) {
        return {
          status: "failed",
          resolvedInput,
          resultPayload: raw,
          resultTruncated: false,
          assertionResults: [],
          error: {
            source: "tool",
            message: `Tool output violated declared outputSchema: ${wrapperFailure.message}`,
            details: {
              outputSchemaViolation: true,
              originalMessage: wrapperFailure.message,
            },
          },
          startedAt,
          durationMs: toolDurationMs,
        };
      }

      // V1-2: 2. JSON-RPC error response check (e.g. -32602 invalid params)
      // When the server actively returned a protocol/business error (not transport drop or timeout)
      if (
        typeof cause?.code === "number"
        && cause.code !== -32001
        && cause.code !== -32000
      ) {
        // Transform into assertable payload so user assertions can inspect jsonRpcError
        raw = {
          jsonRpcError: {
            code: cause.code,
            message: wrapperFailure.message,
            data: cause.data !== undefined ? cause.data : null,
          },
        };
      } else if (classifiedError.source === "timeout") {
        // V1-7: Check if case has duration_s assertion where timeout limit C > threshold T
        const durationAssertion = input.assertions.find(
          (a) =>
            a.type === "metric"
            && (a as { metric?: string }).metric === "duration_s",
        ) as
          | {
              type: "metric";
              metric: string;
              operator: string;
              threshold: number;
            }
          | undefined;

        if (
          durationAssertion
          && durationAssertion.operator === "<"
          && effectiveTimeoutSec > durationAssertion.threshold
        ) {
          return {
            status: "failed",
            resolvedInput,
            resultPayload: null,
            resultTruncated: false,
            assertionResults: [
              {
                index: input.assertions.indexOf(durationAssertion as never),
                type: "metric",
                ok: false,
                expected: `${durationAssertion.operator} ${durationAssertion.threshold}s`,
                actual: `>= ${effectiveTimeoutSec}s (timed out)`,
                message: `Tool execution timed out at ${effectiveTimeoutSec}s, exceeding duration threshold of ${durationAssertion.threshold}s`,
              },
            ],
            error: {
              source: "assertion",
              message: `Tool execution timed out at ${effectiveTimeoutSec}s, exceeding duration threshold of ${durationAssertion.threshold}s`,
              details: {
                timeoutSec: effectiveTimeoutSec,
                threshold: durationAssertion.threshold,
              },
            },
            startedAt,
            durationMs: toolDurationMs,
          };
        }

        return failedOutcome({
          startedAt,
          durationMs: toolDurationMs,
          error: classifiedError,
          resolvedInput,
        });
      } else {
        return failedOutcome({
          startedAt,
          durationMs: toolDurationMs,
          error: classifiedError,
          resolvedInput,
        });
      }
    }

    const mcpIsError =
      isMcpIsError(raw)
      || Boolean((raw as Record<string, unknown>)?.jsonRpcError);
    const variables =
      (runContext?.variables as Record<string, unknown> | undefined) ?? {};
    const outputChars =
      raw == null
        ? 0
        : typeof raw === "string"
        ? raw.length
        : JSON.stringify(raw).length;
    const outcome = evaluateAssertions(raw, input.assertions, {
      input: resolvedInput,
      variables,
      runContext,
      metrics: {
        durationMs: toolDurationMs,
        outputChars,
      },
    });
    const assertionResults = outcome.deterministicResults;
    const allAssertionsPassed = outcome.allDeterministicPassed;

    // V1-3: Runtime fallback for errored assertions (syntax/compile/timeout errors)
    const firstErrored = assertionResults.find((r) => r.errored);
    if (firstErrored) {
      return {
        status: "errored",
        resolvedInput,
        resultPayload: raw,
        resultTruncated: false,
        assertionResults,
        error: {
          source: "config",
          message: firstErrored.message ?? "Assertion configuration error",
          details: {
            assertionIndex: firstErrored.index,
            type: firstErrored.type,
          },
        },
        startedAt,
        durationMs: toolDurationMs,
      };
    }

    let passed: boolean;
    let topLineError: ErrorEnvelope | null = null;

    if (input.assertions.length > 0) {
      // User-defined assertions: pass/fail outcome is strictly governed by assertion verdicts.
      // Negative testing (e.g. testing root.isError == true or jsonRpcError.code == -32602) passes when assertions pass.
      passed = allAssertionsPassed;
      if (!passed) {
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
    } else {
      // Smoke test mode (no assertions configured): passes if tool executed without isError or jsonRpcError.
      passed = !mcpIsError;
      if (mcpIsError) {
        const isProtocolError = Boolean((raw as Record<string, unknown>)?.jsonRpcError);
        topLineError = {
          source: isProtocolError ? "protocol" : "tool",
          message:
            extractMcpErrorText(raw)
            ?? ((raw as { jsonRpcError?: { message?: string } })?.jsonRpcError
              ?.message)
            ?? (isProtocolError ? "MCP JSON-RPC protocol error" : "MCP tool returned error"),
          details: isProtocolError
            ? {
                jsonRpcError: (raw as Record<string, unknown>)?.jsonRpcError,
              }
            : { mcpIsError: true },
        };
      }
    }

    const unresolvedTokens = findUnresolvedTokens(resolvedInput);
    if (topLineError && unresolvedTokens.length > 0) {
      topLineError.details = {
        ...topLineError.details,
        unresolvedReferences: unresolvedTokens,
      };
    }

    return {
      status: passed ? "passed" : "failed",
      resolvedInput,
      resultPayload: raw,
      resultTruncated: false,
      assertionResults,
      error: topLineError,
      startedAt,
      durationMs: toolDurationMs,
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
  resolvedInput?: Record<string, unknown>;
  partialAssertionResults?: AssertionResult[];
}): CaseExecutionOutcome {
  const assertionResults: AssertionResult[] = [
    ...(args.partialAssertionResults ?? []),
    {
      index: args.partialAssertionResults?.length ?? 0,
      type: "error",
      ok: false,
      errorSource: args.error.source,
      message: args.error.message,
    },
  ];
  return {
    status: "errored",
    resultPayload: null,
    resultTruncated: false,
    assertionResults,
    error: args.error,
    startedAt: args.startedAt,
    durationMs: args.durationMs,
    resolvedInput: args.resolvedInput,
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


