import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock, startWebAutoSuiteRunMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  startWebAutoSuiteRunMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

vi.mock("@/lib/web-auto/orchestrator", () => ({
  startWebAutoSuiteRun: startWebAutoSuiteRunMock,
}));

import { POST } from "@/app/api/web-auto-runs/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession, createMockWebAutoSuite } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const SUITE_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const me = { ...EDITOR_USER, id: "user-me-1" };

function makeRequest() {
  return createMockRequest("/api/web-auto-runs", {
    method: "POST",
    body: { suiteId: SUITE_ID },
  });
}

describe("POST /api/web-auto-runs — run gate (F7-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
    startWebAutoSuiteRunMock.mockResolvedValue({ runId: "run-1", totalCount: 3 });
  });

  it("1. foreign private suites are opaque 404", async () => {
    dbMock._chain.where.mockResolvedValueOnce([
      createMockWebAutoSuite({
        id: SUITE_ID,
        visibility: "private",
        createdBy: "user-other-1",
        enabled: true,
        mcpServerId: SERVER_ID,
      }),
    ]);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    expect(startWebAutoSuiteRunMock).not.toHaveBeenCalled();
  });

  it("2. disabled suites are rejected with 400 even for the author", async () => {
    dbMock._chain.where.mockResolvedValueOnce([
      createMockWebAutoSuite({
        id: SUITE_ID,
        visibility: "private",
        createdBy: me.id,
        enabled: false,
        mcpServerId: SERVER_ID,
      }),
    ]);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(startWebAutoSuiteRunMock).not.toHaveBeenCalled();
  });

  it("3. suites without a Playwright binding are rejected with 400", async () => {
    dbMock._chain.where.mockResolvedValueOnce([
      createMockWebAutoSuite({
        id: SUITE_ID,
        visibility: "private",
        createdBy: me.id,
        enabled: true,
        mcpServerId: null,
      }),
    ]);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(startWebAutoSuiteRunMock).not.toHaveBeenCalled();
  });

  it("4. authors can run their own enabled bound suites (202)", async () => {
    dbMock._chain.where.mockResolvedValueOnce([
      createMockWebAutoSuite({
        id: SUITE_ID,
        visibility: "private",
        createdBy: me.id,
        enabled: true,
        mcpServerId: SERVER_ID,
      }),
    ]);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(202);
    expect(startWebAutoSuiteRunMock).toHaveBeenCalledWith({
      suiteId: SUITE_ID,
      ownerId: me.id,
    });
  });

  it("5. collaborators can run public suites (editor = edit on public)", async () => {
    dbMock._chain.where.mockResolvedValueOnce([
      createMockWebAutoSuite({
        id: SUITE_ID,
        visibility: "public",
        createdBy: "user-other-1",
        enabled: true,
        mcpServerId: SERVER_ID,
      }),
    ]);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(202);
  });
});
