import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock, loadVisibleSuiteMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  loadVisibleSuiteMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-verification-cases-123",
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
}));

vi.mock("@/lib/verification/access", () => ({
  loadVisibleSuite: loadVisibleSuiteMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/verification-cases/route";
import { ApiError } from "@/lib/http/route-handlers";
import { db } from "@/lib/db";

const SUITE_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const me = { id: "user-me-1", email: "me@example.com", name: "Me", role: "editor" };

function sessionFor(user: { id: string; role: string }) {
  return { user };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/verification-cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/verification-cases — explicit suiteId RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(sessionFor(me));
  });

  it("1. rejects inserting a case into a foreign private suite (403, no insert)", async () => {
    loadVisibleSuiteMock.mockResolvedValue({
      id: SUITE_ID,
      visibility: "private",
      createdBy: "user-other-1",
    });

    const res = await POST(
      makeRequest({ mcpServerId: SERVER_ID, toolName: "search", name: "case-1", suiteId: SUITE_ID }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("2. foreign private suites look like missing suites (opaque 404 via loadVisibleSuite)", async () => {
    loadVisibleSuiteMock.mockRejectedValue(
      new ApiError("NOT_FOUND", 404, "Verification suite not found."),
    );

    const res = await POST(
      makeRequest({ mcpServerId: SERVER_ID, toolName: "search", name: "case-1", suiteId: SUITE_ID }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(404);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("3. allows inserting into an own suite (editor-authored, edit permitted)", async () => {
    loadVisibleSuiteMock.mockResolvedValue({
      id: SUITE_ID,
      visibility: "private",
      createdBy: me.id,
    });

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          { id: 42, suiteId: SUITE_ID, name: "case-1" },
        ]),
      }),
    } as unknown as ReturnType<typeof db.insert>);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            { id: SUITE_ID, mcpServerId: SERVER_ID, mcpServerName: "My Server" },
          ]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await POST(
      makeRequest({ mcpServerId: SERVER_ID, toolName: "search", name: "case-1", suiteId: SUITE_ID }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("4. admin may insert into any visible suite", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor({ id: "user-admin-1", role: "admin" }),
    );
    loadVisibleSuiteMock.mockResolvedValue({
      id: SUITE_ID,
      visibility: "private",
      createdBy: "user-other-1",
    });

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          { id: 43, suiteId: SUITE_ID, name: "case-admin" },
        ]),
      }),
    } as unknown as ReturnType<typeof db.insert>);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            { id: SUITE_ID, mcpServerId: SERVER_ID, mcpServerName: "Foreign Server" },
          ]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await POST(
      makeRequest({ mcpServerId: SERVER_ID, toolName: "search", name: "case-admin", suiteId: SUITE_ID }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
