import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

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

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-verification-run-detail-123",
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

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/lib/verification/access", () => ({
  loadVisibleSuite: loadVisibleSuiteMock,
}));

vi.mock("@/lib/verification/storage", () => ({
  getRunById: getRunByIdMock,
  listResultsByRun: listResultsByRunMock,
  listResultsByRunForViewer: listResultsByRunForViewerMock,
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/verification-runs/[id]/route";
import { db } from "@/lib/db";

const RUN_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const me = { id: "user-me-1", email: "me@example.com", name: "Me", role: "editor" };
const admin = { id: "user-admin-1", email: "a@example.com", name: "Admin", role: "admin" };

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/verification-runs/${RUN_ID}`, {
    method: "GET",
  });
}

describe("GET /api/verification-runs/[id] — result scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: me });
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
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: SERVER_ID, enabled: true }]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

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
    getSessionMock.mockResolvedValue({ user: admin });
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: null, mcpServerId: SERVER_ID });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: SERVER_ID, enabled: true }]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    await GET(makeRequest(), { params: Promise.resolve({ id: RUN_ID }) });

    expect(listResultsByRunForViewerMock).toHaveBeenCalledWith(RUN_ID, {
      userId: admin.id,
      isAdmin: true,
      isEditor: true,
    });
  });

  it("4. server-scoped runs on invisible servers stay opaque 404", async () => {
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: null, mcpServerId: SERVER_ID });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: RUN_ID }) });
    expect(res.status).toBe(404);
    expect(listResultsByRunForViewerMock).not.toHaveBeenCalled();
  });
});
