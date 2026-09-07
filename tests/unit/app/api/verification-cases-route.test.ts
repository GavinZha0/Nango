import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock, loadVisibleSuiteMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  loadVisibleSuiteMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/verification/access", () => ({
  loadVisibleSuite: loadVisibleSuiteMock,
}));

import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { POST } from "@/app/api/verification-cases/route";
import { ApiError } from "@/lib/http/route-handlers";
import { db } from "@/lib/db";
import { ADMIN_USER, EDITOR_USER, createMockSession, createMockVerificationSuite } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const SUITE_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const me = { ...EDITOR_USER, id: "user-me-1" };

function makeRequest(body: Record<string, unknown>) {
  return createMockRequest("/api/verification-cases", {
    method: "POST",
    body,
  });
}

describe("POST /api/verification-cases — explicit suiteId RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
  });

  it("1. rejects inserting a case into a foreign private suite (403, no insert)", async () => {
    loadVisibleSuiteMock.mockResolvedValue(
      createMockVerificationSuite({
        id: SUITE_ID,
        visibility: "private",
        createdBy: "user-other-1",
      }),
    );

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
    loadVisibleSuiteMock.mockResolvedValue(
      createMockVerificationSuite({
        id: SUITE_ID,
        visibility: "private",
        createdBy: me.id,
      }),
    );

    dbMock._chain.returning.mockResolvedValueOnce([
      { id: 42, suiteId: SUITE_ID, name: "case-1" },
    ]);
    dbMock._chain.limit.mockResolvedValueOnce([
      { id: SUITE_ID, mcpServerId: SERVER_ID, mcpServerName: "My Server" },
    ]);

    const res = await POST(
      makeRequest({ mcpServerId: SERVER_ID, toolName: "search", name: "case-1", suiteId: SUITE_ID }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("4. admin may insert into any visible suite", async () => {
    getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));
    loadVisibleSuiteMock.mockResolvedValue(
      createMockVerificationSuite({
        id: SUITE_ID,
        visibility: "private",
        createdBy: "user-other-1",
      }),
    );

    dbMock._chain.returning.mockResolvedValueOnce([
      { id: 43, suiteId: SUITE_ID, name: "case-admin" },
    ]);
    dbMock._chain.limit.mockResolvedValueOnce([
      { id: SUITE_ID, mcpServerId: SERVER_ID, mcpServerName: "Foreign Server" },
    ]);

    const res = await POST(
      makeRequest({ mcpServerId: SERVER_ID, toolName: "search", name: "case-admin", suiteId: SUITE_ID }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
