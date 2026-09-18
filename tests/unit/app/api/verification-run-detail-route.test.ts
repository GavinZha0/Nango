import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSessionMock,
  getRunByIdMock,
  loadVisibleSuiteMock,
  listResultsByRunMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getRunByIdMock: vi.fn(),
  loadVisibleSuiteMock: vi.fn(),
  listResultsByRunMock: vi.fn(),
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
}));

import { GET } from "@/app/api/verification-runs/[id]/route";
import { ApiError } from "@/lib/http/route-handlers";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const RUN_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const me = { ...EDITOR_USER, id: "user-me-1" };

function makeRequest(id: string = RUN_ID) {
  return createMockRequest(`/api/verification-runs/${id}`, {
    method: "GET",
  });
}

describe("GET /api/verification-runs/[id] — result scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(createMockSession(me));
    listResultsByRunMock.mockResolvedValue([
      { id: "result-1" },
      { id: "result-2" },
    ]);
  });

  it("1. suite-scoped runs read results successfully", async () => {
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: "suite-1" });
    loadVisibleSuiteMock.mockResolvedValue({ id: "suite-1" });

    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: RUN_ID }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.results).toHaveLength(2);
    expect(data.visibleCount).toBe(2);
    expect(listResultsByRunMock).toHaveBeenCalledWith(RUN_ID);
    expect(loadVisibleSuiteMock).toHaveBeenCalledWith("suite-1", expect.anything());
  });

  it("2. returns 404 when run is not found", async () => {
    getRunByIdMock.mockResolvedValue(null);

    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: RUN_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("3. returns 404 when run ID is invalid UUID", async () => {
    const res = await GET(makeRequest("invalid-uuid"), {
      params: Promise.resolve({ id: "invalid-uuid" }),
    });
    expect(res.status).toBe(404);
  });

  it("4. returns 404 when suite is not visible to the user", async () => {
    getRunByIdMock.mockResolvedValue({ id: RUN_ID, suiteId: "suite-private" });
    loadVisibleSuiteMock.mockRejectedValue(
      new ApiError("NOT_FOUND", 404, "Verification suite not found."),
    );

    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: RUN_ID }),
    });
    expect(res.status).toBe(404);
  });
});
