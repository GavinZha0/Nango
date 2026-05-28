/**
 * Unit tests for the API route HOFs and standard error envelope.
 *
 * The HOFs depend on:
 *   - `getSession()` from `@/lib/auth/auth-instance` — mocked here to
 *     control the auth outcome per test.
 *   - `childLogger` / `newRequestId` from `@/lib/observability/logger`
 *     — mocked to a no-op logger so tests don't write to stderr and
 *     `requestId` is deterministic.
 *
 * Mocking `auth-instance` also suppresses its `import "server-only"`
 * marker (vitest doesn't have a server context), which would otherwise
 * fail to evaluate. Same for `validation.ts`'s import.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks must be declared before the module under test is imported ──────────
//
// `vi.mock` is hoisted to the top of the file, so any references inside its
// factory must also be hoisted via `vi.hoisted()` to avoid TDZ errors.

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      trace: () => {},
    }),
  }),
  newRequestId: () => "test-request-id",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

// `server-only` blocks evaluation outside a Next.js server context.
// Stub it to a no-op for tests.
vi.mock("server-only", () => ({}));

import { NextRequest, NextResponse } from "next/server";

import {
  ApiError,
  apiError,
  withAdmin,
  withSession,
} from "@/lib/http/route-handlers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(
  url: string = "https://app.test/api/x",
  method: string = "GET",
): NextRequest {
  return new NextRequest(url, { method });
}

function emptyParams(): { params: Promise<Record<string, never>> } {
  return { params: Promise.resolve({}) };
}

interface UserSession {
  user: { id: string; role: string };
}

const adminSession: UserSession = { user: { id: "u1", role: "admin" } };
const userSession: UserSession = { user: { id: "u2", role: "user" } };

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getSessionMock.mockReset();
});

describe("ApiError", () => {
  it("captures code, status, message, and optional details", () => {
    const err = new ApiError("NOT_FOUND", 404, "Agent not found.", {
      hint: "check id",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Agent not found.");
    expect(err.details).toEqual({ hint: "check id" });
  });

  it("leaves details undefined when omitted", () => {
    const err = new ApiError("INTERNAL", 500, "boom");
    expect(err.details).toBeUndefined();
  });
});

describe("apiError", () => {
  it("produces the standard envelope at the declared status", async () => {
    const res = apiError({
      code: "FORBIDDEN",
      status: 403,
      message: "no",
      requestId: "rid-1",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "no",
      requestId: "rid-1",
    });
  });

  it("includes details only when provided", async () => {
    const res = apiError({
      code: "VALIDATION_FAILED",
      status: 400,
      message: "bad input",
      requestId: "rid-2",
      details: { issues: [{ path: "name", message: "required" }] },
    });
    expect(await res.json()).toEqual({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "bad input",
      requestId: "rid-2",
      details: { issues: [{ path: "name", message: "required" }] },
    });
  });
});

describe("withSession", () => {
  it("returns 401 UNAUTHENTICATED when no session", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const handler = vi.fn();
    const route = withSession("/api/x", handler);

    const res = await route(makeRequest(), emptyParams());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
      requestId: "test-request-id",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes handler with session, params, requestId, log when authed", async () => {
    getSessionMock.mockResolvedValueOnce(userSession);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const route = withSession<{ id: string }>("/api/x/[id]", handler);

    const res = await route(makeRequest(), {
      params: Promise.resolve({ id: "abc" }),
    });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = handler.mock.calls[0][0];
    expect(ctx.session).toBe(userSession);
    expect(ctx.params).toEqual({ id: "abc" });
    expect(ctx.requestId).toBe("test-request-id");
    expect(typeof ctx.log.warn).toBe("function");
    expect(ctx.req).toBeInstanceOf(NextRequest);
  });

  it("renders ApiError thrown inside handler with declared status + envelope", async () => {
    getSessionMock.mockResolvedValueOnce(userSession);
    const route = withSession("/api/x", async () => {
      throw new ApiError("NOT_FOUND", 404, "missing", { id: "42" });
    });

    const res = await route(makeRequest(), emptyParams());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "missing",
      requestId: "test-request-id",
      details: { id: "42" },
    });
  });

  it("converts unknown errors to 500 INTERNAL without leaking message", async () => {
    getSessionMock.mockResolvedValueOnce(userSession);
    const route = withSession("/api/x", async () => {
      throw new Error("internal stack-trace-y detail");
    });

    const res = await route(makeRequest(), emptyParams());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      code: "INTERNAL",
      message: "Internal server error.",
      requestId: "test-request-id",
    });
    // Importantly: the original error message is NOT in the response.
    expect(JSON.stringify(body)).not.toContain("stack-trace-y");
  });

  it("falls back to empty params when ctx.params resolves to null/undefined", async () => {
    getSessionMock.mockResolvedValueOnce(userSession);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const route = withSession("/api/x", handler);

    // Simulate Next 16 handing us nothing for a route with no [param] segment.
    await route(makeRequest(), {
      params: Promise.resolve(undefined as unknown as Record<string, never>),
    });

    expect(handler.mock.calls[0][0].params).toEqual({});
  });
});

describe("withAdmin", () => {
  it("returns 403 FORBIDDEN when authed but not admin", async () => {
    getSessionMock.mockResolvedValueOnce(userSession);
    const handler = vi.fn();
    const route = withAdmin("/api/admin/x", handler);

    const res = await route(makeRequest(), emptyParams());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required to access this resource.",
      requestId: "test-request-id",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when no session (delegates to withSession)", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const handler = vi.fn();
    const route = withAdmin("/api/admin/x", handler);

    const res = await route(makeRequest(), emptyParams());

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes handler when role === admin", async () => {
    getSessionMock.mockResolvedValueOnce(adminSession);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const route = withAdmin("/api/admin/x", handler);

    const res = await route(makeRequest(), emptyParams());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].session).toBe(adminSession);
  });
});
