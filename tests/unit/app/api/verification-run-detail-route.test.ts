import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSessionMock,
  getRunByIdMock,
  loadVisibleSuiteMock,
  listResultsByRunMock,
  listResultsByRunForViewerMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getRunByIdMock: vi.fn(),
  loadVisibleSuiteMock: vi.fn(),
  listResultsByRunMock: vi.fn(),
  listResultsByRunForViewerMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

vi.mock("@/lib/verification/access", () => ({
  loadVisibleSuite: loadVisibleSuiteMock,
}));

vi.mock("@/lib/verification/storage", () => ({
  getRunById: getRunByIdMock,
  listResultsByRun: listResultsByRunMock,
  listResultsByRunForViewer: listResultsByRunForViewerMock,
}));

import { GET } from "@/app/api/verification-runs/[id]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { ADMIN_USER, EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const RUN_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const me = { ...EDITOR_USER, id: "user-me-1" };
const admin = ADMIN_USER;

function makeRequest() {
  return createMockRequest(`/api/verification-runs/${RUN_ID}`, {
    method: "GET",
  });
}

describe("GET /api/verification-runs/[id] — result scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
    listResultsByRunMock.mockResolvedValue([{ id: "result-1" }, { id: "result-2" }]);
    listResultsByRunForViewerMock.mockResolvedValue([{ id: "result-1" }]);
  });

  it("1. suite-scoped runs read results unfiltered (suite already gated)", async () => {
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: "suite-1", mcpServerId: null });
    loadVisibleSuiteMock.mockResolvedValue({ id: "suite-1" });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: RUN_ID }) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.results).toHaveLength(2);
    expect(data.visibleCount).toBe(2);
    expect(listResultsByRunMock).toHaveBeenCalledWith(RUN_ID);
    expect(listResultsByRunForViewerMock).not.toHaveBeenCalled();
  });

  it("2. server-scoped runs filter results by viewer visibility", async () => {
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: null, mcpServerId: SERVER_ID });
    dbMock._chain.limit.mockResolvedValueOnce([{ id: SERVER_ID, enabled: true }]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: RUN_ID }) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.results).toHaveLength(1);
    expect(data.visibleCount).toBe(1);
    expect(listResultsByRunForViewerMock).toHaveBeenCalledWith(RUN_ID, {
      userId: me.id,
      isAdmin: false,
      isEditor: true,
    });
    expect(listResultsByRunMock).not.toHaveBeenCalled();
  });

  it("3. admin viewing a server-scoped run sees all results (isAdmin passthrough)", async () => {
    getSessionMock.mockResolvedValue(createMockSession(admin));
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: null, mcpServerId: SERVER_ID });
    dbMock._chain.limit.mockResolvedValueOnce([{ id: SERVER_ID, enabled: true }]);

    await GET(makeRequest(), { params: Promise.resolve({ id: RUN_ID }) });

    expect(listResultsByRunForViewerMock).toHaveBeenCalledWith(RUN_ID, {
      userId: admin.id,
      isAdmin: true,
      isEditor: true,
    });
  });

  it("4. server-scoped runs on invisible servers stay opaque 404", async () => {
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: null, mcpServerId: SERVER_ID });
    dbMock._chain.limit.mockResolvedValueOnce([]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: RUN_ID }) });
    expect(res.status).toBe(404);
    expect(listResultsByRunForViewerMock).not.toHaveBeenCalled();
  });
});
