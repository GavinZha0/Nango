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
 * Layering rule (best-effort in V1 — V2 may sidecar-probe upstream
 * directly to disambiguate further):
 *
 *   - Node transport code (ECONNREFUSED, etc.)  → "transport"
 *   - HTTP 4xx                                  → "upstream"
 *   - HTTP 5xx with `x-mcphub-source: upstream` → "upstream"
 *   - HTTP 5xx with `x-mcphub-source: mcphub`   → "mcphub"
 *   - HTTP 5xx without source header            → "mcphub" (conservative)
 *   - Anything else                             → "internal"
 *
 * The MCP TypeScript SDK throws a generic `Error` for HTTP failures
 * with the message containing `HTTP NNN` text. We parse that out as
 * a fallback when no structured status field is available.
 */
export function classifyMcpError(err: unknown): ErrorEnvelope {
  if (err instanceof Error) {
    const code: string | undefined = readErrorCode(err);
    if (code && TRANSPORT_CODES.has(code)) {
      return {
        source: "transport",
        message: err.message || code,
        details: { code, target: readErrorTarget(err) },
      };
    }

    const status: number | null = extractHttpStatus(err);
    const source: string | null = readMcphubSourceHeader(err);

    if (status !== null) {
      if (status >= 400 && status < 500) {
        return {
          source: "upstream",
          message: err.message,
          details: { httpStatus: status, ...(source ? { mcphubSource: source } : {}) },
        };
      }
      if (status >= 500) {
        // 5xx — disambiguate by header if present, otherwise default
        // to "mcphub" (the layer Nango owns) so the user looks at the
        // proxy first.
        const inferred = source === "upstream" ? "upstream" : "mcphub";
        return {
          source: inferred,
          message: err.message,
          details: { httpStatus: status, ...(source ? { mcphubSource: source } : {}) },
        };
      }
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

function readErrorCode(err: Error): string | undefined {
  const c = (err as unknown as { code?: unknown }).code;
  return typeof c === "string" ? c : undefined;
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

/**
 * Read `x-mcphub-source` header from the error if MCPHub forwarded
 * it. The MCP SDK doesn't expose response headers in a stable place
 * — this is best-effort and defaults to `null` when unavailable.
 */
function readMcphubSourceHeader(err: Error): string | null {
  const headers = (err as unknown as { headers?: Headers | Record<string, string> })
    .headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("x-mcphub-source");
  }
  const rec = headers as Record<string, string>;
  return rec["x-mcphub-source"] ?? rec["X-MCPHub-Source"] ?? null;
}
