/**
 * Langfuse client (Phase 2 of the observability layer).
 */

import "server-only";

import { Langfuse } from "langfuse";
import type { LangfuseTraceClient } from "langfuse";

import {
  getEnabledObservabilityCredential,
  onCredentialCacheInvalidated,
  type ObservabilityCredentialConfig,
} from "@/lib/credentials/lookup";
import { logger } from "@/lib/observability/logger";

// Targets

export type TracingTarget = "builtin" | "frontend" | "proxy_errors";

const DEFAULT_TARGETS: ReadonlySet<TracingTarget> = new Set([
  "builtin",
  "frontend",
  "proxy_errors",
]);

import { getConfig } from "@/lib/config";

function parsedTargets(): ReadonlySet<TracingTarget> {
  const raw = getConfig("observability.langfuse.targets", "builtin,frontend,proxy_errors");
  const allowed = new Set<TracingTarget>();
  for (const part of raw.split(",").map((s) => s.trim())) {
    if (part === "builtin" || part === "frontend" || part === "proxy_errors") {
      allowed.add(part);
    }
  }
  return allowed.size > 0 ? allowed : DEFAULT_TARGETS;
}

/** CONTRACT: cheap — safe to call inline before any allocation work.
 *  Credential's `enabled` flag is checked separately by `resolveClient`. */
export function tracingEnabled(target: TracingTarget): boolean {
  return parsedTargets().has(target);
}

// Lazy singleton
//
// @see docs/observability.md#37
// three-state cache: undefined = not init; null = no usable credential; Langfuse = ready.
//
// HMR-survival via globalThis: the langfuse client opens an HTTP
// background flusher; a dev save without pinning would leak the old
// flusher AND push a duplicate invalidation subscription into the
// (pinned) credential cache subscribers list.
interface LangfuseHolder {
  client: Langfuse | null | undefined;
  initPromise: Promise<Langfuse | null> | null;
  subscribed: boolean;
}

declare global {
  var __nangoLangfuse: LangfuseHolder | undefined;
}

const langfuseHolder: LangfuseHolder = (globalThis.__nangoLangfuse ??= {
  client: undefined,
  initPromise: null,
  subscribed: false,
});

async function resolveClient(): Promise<Langfuse | null> {
  if (langfuseHolder.client !== undefined) return langfuseHolder.client;
  if (langfuseHolder.initPromise) return langfuseHolder.initPromise;

  // Register invalidation exactly once (lazy) so credential rotations rebuild the client.
  if (!langfuseHolder.subscribed) {
    onCredentialCacheInvalidated(invalidateLangfuseClient);
    langfuseHolder.subscribed = true;
  }

  langfuseHolder.initPromise = (async () => {
    const cred: ObservabilityCredentialConfig | null =
      await getEnabledObservabilityCredential();

    if (!cred || cred.provider !== "langfuse") {
      logger.debug(
        {
          component: "langfuse",
          event: "init_skipped",
          reason: cred ? `unsupported_provider:${cred.provider}` : "no_credential",
        },
        "no langfuse credential available; tracing disabled",
      );
      langfuseHolder.client = null;
      return null;
    }

    if (!cred.publicKey || !cred.secretKey) {
      logger.warn(
        {
          component: "langfuse",
          event: "init_skipped",
          reason: "missing_keys",
          credentialId: cred.id,
        },
        "langfuse credential is missing publicKey or secretKey",
      );
      langfuseHolder.client = null;
      return null;
    }

    try {
      langfuseHolder.client = new Langfuse({
        publicKey: cred.publicKey,
        secretKey: cred.secretKey,
        ...(cred.host ? { baseUrl: cred.host } : {}),
        // @see docs/observability.md#37-implementation-details-and-quirks
        flushAt: 1,
        sdkIntegration: "nango",
      });
      logger.info(
        { component: "langfuse", event: "init_ok", host: cred.host ?? "default" },
        "langfuse client initialised",
      );
      return langfuseHolder.client;
    } catch (err) {
      logger.error(
        {
          component: "langfuse",
          event: "init_failed",
          err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
        },
        "langfuse client construction failed",
      );
      langfuseHolder.client = null;
      return null;
    }
  })();

  return langfuseHolder.initPromise;
}

/** Reset the cached client + targets. Call after the observability
 *  credential is created / updated / deleted. */
export function invalidateLangfuseClient(): void {
  langfuseHolder.client = undefined;
  langfuseHolder.initPromise = null;
}

// Trace helpers

export interface WithTraceOptions {
  target: TracingTarget;
  /** Trace name; appears as the row label in Langfuse. */
  name: string;
  /** Authenticated user id (powers per-user analytics). */
  userId?: string;
  /** Conversation thread id (groups multi-turn traces). */
  sessionId?: string;
  /** Free-form tags — typically `[agent:<id>, provider:<slug>]`. */
  tags?: string[];
  /** SECURITY: anything useful for debugging (no secrets — see logger redact). */
  metadata?: Record<string, unknown>;
  input?: unknown;
}

/**
 * Run `fn` inside a Langfuse trace.
 *
 * CONTRACT: trace is started before `fn` runs, finalised in `finally`.
 *   - success → trace updated with `durationMs` metadata + caller's
 *     `output` via `trace.update`.
 *   - failure → tagged `"error"`, message recorded in metadata +
 *     output, ERROR-level child event attached. Original error
 *     re-thrown.
 *
 * @see docs/observability.md#37-implementation-details-and-quirks
 *
 * When tracing is disabled (env / missing credential / target not
 * allowed), `fn` runs as-is and `trace` is `null` — callers must
 * null-check before calling `trace.span(...)`.
 */
export async function withTrace<T>(
  options: WithTraceOptions,
  fn: (trace: LangfuseTraceClient | null) => Promise<T>,
): Promise<T> {
  if (!tracingEnabled(options.target)) return fn(null);

  const client = await resolveClient();
  if (!client) return fn(null);

  const trace = client.trace({
    name: options.name,
    userId: options.userId,
    sessionId: options.sessionId,
    tags: options.tags,
    metadata: options.metadata,
    input: options.input,
  });
  const startedAt = Date.now();

  try {
    const result = await fn(trace);
    trace.update({
      metadata: { ...(options.metadata ?? {}), durationMs: Date.now() - startedAt },
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorTags = [...(options.tags ?? []), "error"];
    trace.update({
      tags: errorTags,
      output: { error: message },
      metadata: {
        ...(options.metadata ?? {}),
        durationMs: Date.now() - startedAt,
        error: message,
      },
    });
    trace.event({
      name: "error",
      level: "ERROR",
      statusMessage: message,
      input: options.input,
    });
    throw err;
  }
}

// Lifecycle

/**
 * Flush buffered events. CONTRACT: call before a route handler
 * returns on serverless platforms that may suspend the process —
 * otherwise `flushAt:1` events still in-flight may be lost. No-op on
 * long-running Node servers (background flush keeps the queue empty).
 */
export async function flushLangfuse(): Promise<void> {
  if (!langfuseHolder.client) return;
  try {
    await langfuseHolder.client.flushAsync();
  } catch (err) {
    logger.warn(
      {
        component: "langfuse",
        event: "flush_failed",
        err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
      },
      "langfuse flush failed",
    );
  }
}
