/**
 * Verification — error classification.
 *
 * Maps raw thrown errors / MCP responses into the structured
 * {@link ErrorEnvelope} that's persisted on `verification_case_result.error`.
 *
 * See docs/verification.md.
 */

import "server-only";

import type { ErrorEnvelope } from "./types";

/** Common Node `Error.code` strings that indicate the request never
 *  reached the upstream. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/**
 * Classify a thrown error from {@link McpClient.callTool} (or the
 * pool borrow path) into a structured {@link ErrorEnvelope}.
 *
 * Layering rule (gateway-agnostic, single-node execution):
 *
 *   - Node transport code (ECONNREFUSED, etc.)  → "transport"
 *   - Timeout code (-32001 / TimeoutError)     → "timeout"
 *   - Connection code (-32000)                 → "transport"
 *   - JSON-RPC numeric code (-32602, etc.)     → "protocol"
 *   - HTTP 4xx / 5xx                           → "endpoint"
 *   - Anything else                            → "internal"
 *
 * The MCP TypeScript SDK throws a generic `Error` for HTTP failures
 * with the message containing `HTTP NNN` text. We parse that out as
 * a fallback when no structured status field is available.
 */
export function classifyMcpError(err: unknown): ErrorEnvelope {
  if (err instanceof Error) {
    const code: string | number | undefined = readErrorCode(err);
    if (code !== undefined) {
      if (typeof code === "string" && TRANSPORT_CODES.has(code)) {
        return {
          source: "transport",
          message: err.message || code,
          details: { code, target: readErrorTarget(err) },
        };
      }
      // JSON-RPC / MCP specific codes
      if (code === -32001) {
        return {
          source: "timeout",
          message: err.message || "MCP request timed out",
          details: { code },
        };
      }
      if (code === -32000) {
        return {
          source: "transport",
          message: err.message || "MCP connection error",
          details: { code },
        };
      }
      if (typeof code === "number") {
        const rawData = (err as { data?: unknown }).data;
        return {
          source: "protocol",
          message: err.message || `JSON-RPC error ${code}`,
          details: {
            code,
            ...(rawData !== undefined ? { data: rawData } : {}),
          },
        };
      }
    }

    if (err.message && err.message.includes("is in failure cooldown")) {
      return {
        source: "transport",
        message: err.message,
        details: { cooldown: true },
      };
    }

    if (err.name === "TimeoutError") {
      return {
        source: "timeout",
        message: err.message || "Operation timed out",
        details: { code, name: err.name },
      };
    }

    const status: number | null = extractHttpStatus(err);
    if (status !== null) {
      return {
        source: "endpoint",
        message: err.message,
        details: { httpStatus: status },
      };
    }

    // QUIRK: Text-only timeout phrases without a verified -32001 code or TimeoutError
    // represent external/gateway dropouts, not execution of Nango's configured case timeout.
    // Classify as transport so V1-7 duration_s logic does not falsely mark them as failed assertions.
    if (/(?:timed?\s*out|timeout)/i.test(err.message)) {
      return {
        source: "transport",
        message: err.message,
        details: { code, unconfirmedTimeout: true },
      };
    }

    return {
      source: "internal",
      message: err.message,
      details: { name: err.name, stack: err.stack },
    };
  }

  // Non-Error throw — preserve the value for forensics.
  return {
    source: "internal",
    message: String(err),
    details: { raw: err as unknown },
  };
}

/**
 * Construct a `timeout` envelope. `scope` distinguishes a per-case
 * cap (none in V1) from the suite-level wall-clock cap.
 */
export function timeoutError(
  scope: "case" | "suite",
  elapsedMs: number,
): ErrorEnvelope {
  return {
    source: "timeout",
    message: `${scope === "suite" ? "Suite" : "Case"} timeout after ${elapsedMs} ms`,
    details: { scope, elapsedMs },
  };
}

/**
 * Construct an `assertion` envelope. Populated only when we want to
 * surface ONE failing assertion as the top-line error message even
 * though the full per-assertion verdict list lives in
 * `assertionResults`. See `runner-mcp.ts`.
 */
export function assertionError(
  path: string,
  expected: unknown,
  actual: unknown,
): ErrorEnvelope {
  return {
    source: "assertion",
    message: `Assertion failed at ${path}`,
    details: { assertionPath: path, expected, actual },
  };
}

// --- Internals ---------------------------------------------------------------

function readErrorCode(err: Error): string | number | undefined {
  const c = (err as unknown as { code?: unknown }).code;
  if (typeof c === "string" || typeof c === "number") return c;
  return undefined;
}

function readErrorTarget(err: Error): string | undefined {
  const host = (err as unknown as { address?: unknown }).address;
  const port = (err as unknown as { port?: unknown }).port;
  if (typeof host === "string") {
    return typeof port === "number" ? `${host}:${port}` : host;
  }
  return undefined;
}

/** Look for an HTTP status on the error or in its message. */
function extractHttpStatus(err: Error): number | null {
  const direct = (err as unknown as { status?: unknown; statusCode?: unknown }).status;
  if (typeof direct === "number") return direct;
  const indirect = (err as unknown as { statusCode?: unknown }).statusCode;
  if (typeof indirect === "number") return indirect;

  // The MCP SDK formats HTTP failures like
  //   "Error POSTing to endpoint (HTTP 502): Bad Gateway"
  // Parse defensively.
  const m = /HTTP\s+(\d{3})/i.exec(err.message);
  if (m) {
    const n = Number(m[1]);
    if (n >= 100 && n < 600) return n;
  }
  return null;
}

