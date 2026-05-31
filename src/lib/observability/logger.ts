/**
 * Structured logger (pino) for the Nango proxy + Built-In runtime.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import pino, { type Logger as PinoLogger } from "pino";

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

const enabled = parseBool(process.env.NANGO_LOG_ENABLED, true);
// Default JSON-only so container log shippers (Loki, Datadog,
// CloudWatch) work out of the box. Set NANGO_LOG_PRETTY=true in
// dev `.env` for human-readable colourised output.
const pretty = parseBool(process.env.NANGO_LOG_PRETTY, false);
const level = enabled
  ? (process.env.NANGO_LOG_LEVEL ?? "info")
  : "silent";

/** SECURITY: keep conservative — false positives only blank fields,
 *  but a missing entry leaks secrets. `*` matches any single key. */
const REDACT_PATHS = [
  // Generic credential fields
  "token",
  "secretKey",
  "publicKey",
  "password",
  "apiKey",
  "encryptedPayload",
  "*.token",
  "*.secretKey",
  "*.publicKey",
  "*.password",
  "*.apiKey",
  "*.encryptedPayload",
  // HTTP headers (case-insensitive — pino normalises)
  "headers.authorization",
  "headers.cookie",
  "headers['x-credential-id']",
  "*.headers.authorization",
  "*.headers.cookie",
];

export const logger: PinoLogger = pino({
  level,
  base: { service: "nango" },
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
    remove: false,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // pino-pretty runs in a worker thread loaded via dynamic require().
  // Next.js standalone needs `outputFileTracingIncludes` to ship the
  // module (see next.config.ts) — without that the worker fails to
  // resolve the transport at startup.
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,service",
            singleLine: false,
          },
        },
      }
    : {}),
});

/** Child logger with bound context fields — use one per request for
 *  automatic correlation. */
export function childLogger(bindings: Record<string, unknown>): PinoLogger {
  return logger.child(bindings);
}

/** UUID v4 request id for log correlation. */
export function newRequestId(): string {
  return randomUUID();
}

/**
 * Time an async op and emit one log line on completion (success / failure).
 *
 *   const result = await timed(log, "backend_dispatch", async () =>
 *     chatHandler.handleChat(req, ctx)
 *   );
 */
export async function timed<T>(
  log: PinoLogger,
  event: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    log.info(
      { event, durationMs: Date.now() - start, ...extra },
      `${event} ok`,
    );
    return result;
  } catch (err) {
    log.error(
      {
        event,
        durationMs: Date.now() - start,
        err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
        ...extra,
      },
      `${event} failed`,
    );
    throw err;
  }
}
