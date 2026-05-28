/**
 * API route higher-order handlers + standardised error envelope.
 */
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import type { Logger } from "pino";

import { getSession } from "@/lib/auth/auth-instance";
import { childLogger, newRequestId } from "@/lib/observability/logger";

/** 
 * better-auth doesn't export a stable `Session` type; infer
 * from `getSession()` so we stay in sync automatically. 
 */
export type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

// Error codes

/** CONTRACT: stable, machine-readable. New codes can be added freely;
 *  existing ones must not change meaning (treat as a public enum). */
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL"
  | "BAD_GATEWAY"
  | "SERVICE_UNAVAILABLE";

export interface ApiErrorBody {
  ok: false;
  code: ApiErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}

// Throwable error

/**
 * Throw inside a wrapped handler to short-circuit with the standard
 * envelope. CONTRACT: prefer over `apiError(...)` — `throw` avoids
 * threading `requestId` through every callee.
 */
export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Direct envelope factory

/** Direct envelope when `return` is more natural than `throw` (e.g.
 *  inside the wrapper itself). */
export function apiError(args: {
  code: ApiErrorCode;
  status: number;
  message: string;
  requestId: string;
  details?: unknown;
}): NextResponse {
  const body: ApiErrorBody = {
    ok: false,
    code: args.code,
    message: args.message,
    requestId: args.requestId,
  };
  if (args.details !== undefined) body.details = args.details;
  return NextResponse.json(body, { status: args.status });
}

// Handler context types

export interface SessionedContext<P> {
  req: NextRequest;
  params: P;
  session: Session;
  requestId: string;
  log: Logger;
}

export type SessionedHandler<P> = (
  ctx: SessionedContext<P>,
) => Promise<Response>;

/** Empty params type for routes without dynamic segments. */
export type NoParams = Record<string, never>;

type NextHandler<P> = (
  req: NextRequest,
  ctx: { params: Promise<P> },
) => Promise<Response>;

// Internal: shared request bootstrap

interface RequestBootstrap {
  requestId: string;
  log: Logger;
  start: number;
}

function bootstrap(req: NextRequest, route: string): RequestBootstrap {
  const requestId: string = newRequestId();
  const url: URL = new URL(req.url);
  const log: Logger = childLogger({
    requestId,
    route,
    method: req.method,
    path: url.pathname,
  });
  return { requestId, log, start: Date.now() };
}

/** SECURITY: ApiError surfaces declared status; everything else is
 *  500 INTERNAL with the original error logged but never echoed. */
function errorToResponse(
  err: unknown,
  requestId: string,
  log: Logger,
  durationMs: number,
): NextResponse {
  if (err instanceof ApiError) {
    log.warn(
      {
        event: "api_error",
        code: err.code,
        status: err.status,
        durationMs,
      },
      err.message,
    );
    return apiError({
      code: err.code,
      status: err.status,
      message: err.message,
      requestId,
      details: err.details,
    });
  }

  log.error(
    {
      event: "unhandled_error",
      err:
        err instanceof Error
          ? { message: err.message, name: err.name, stack: err.stack }
          : String(err),
      durationMs,
    },
    "unhandled error in route handler",
  );
  return apiError({
    code: "INTERNAL",
    status: 500,
    message: "Internal server error.",
    requestId,
  });
}

// HOF: withSession

/**
 * Wrap a handler with session-required auth.
 *
 * @param route - logical path for log binding (e.g. `/api/builtin-agents/[id]`).
 * @param handler - receives `SessionedContext` with session, params,
 *                  requestId, bound logger.
 *
 * CONTRACT: 401 envelope if no session; ApiError → declared status;
 * anything else → 500 INTERNAL.
 */
export function withSession<P = NoParams>(
  route: string,
  handler: SessionedHandler<P>,
): NextHandler<P> {
  return async (req, ctx) => {
    const { requestId, log, start } = bootstrap(req, route);

    try {
      const session: Session | null = await getSession();
      if (!session) {
        log.warn(
          {
            event: "auth",
            outcome: "unauthenticated",
            durationMs: Date.now() - start,
          },
          "unauthenticated",
        );
        return apiError({
          code: "UNAUTHENTICATED",
          status: 401,
          message: "Authentication required.",
          requestId,
        });
      }

      const params: P = ((await ctx.params) ?? {}) as P;
      const response = await handler({ req, params, session, requestId, log });

      log.debug(
        {
          event: "request",
          outcome: "success",
          status: response.status,
          userId: session.user.id,
          durationMs: Date.now() - start,
        },
        "request completed",
      );
      return response;
    } catch (err) {
      return errorToResponse(err, requestId, log, Date.now() - start);
    }
  };
}

// HOF: withEditor

/**
 * `withSession` + `role ∈ {admin, editor}` guard (403 if not).
 *
 * Used by AI-resource CRUD routes (skill / mcp_server / builtin_agent).
 * See docs/rbac.md.
 */
export function withEditor<P = NoParams>(
  route: string,
  handler: SessionedHandler<P>,
): NextHandler<P> {
  return withSession<P>(route, async (ctx) => {
    const role = ctx.session.user.role;
    if (role !== "admin" && role !== "editor") {
      ctx.log.warn(
        {
          event: "auth",
          outcome: "forbidden",
          userId: ctx.session.user.id,
          role,
        },
        "non-editor attempted editor route",
      );
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Editor role required to access this resource.",
      );
    }
    return handler(ctx);
  });
}

// HOF: withAdmin

/** `withSession` + `session.user.role === "admin"` guard (403 if not). */
export function withAdmin<P = NoParams>(
  route: string,
  handler: SessionedHandler<P>,
): NextHandler<P> {
  return withSession<P>(route, async (ctx) => {
    if (ctx.session.user.role !== "admin") {
      ctx.log.warn(
        {
          event: "auth",
          outcome: "forbidden",
          userId: ctx.session.user.id,
          role: ctx.session.user.role,
        },
        "non-admin attempted admin route",
      );
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Admin role required to access this resource.",
      );
    }
    return handler(ctx);
  });
}
