import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock, loadCaseMock, getLatestCaseResultMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  loadCaseMock: vi.fn(),
  getLatestCaseResultMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/evaluation/access", () => ({
  loadCase: loadCaseMock,
}));

vi.mock("@/lib/evaluation/storage", () => ({
  getLatestCaseResult: getLatestCaseResultMock,
}));

import { GET } from "@/app/api/eval-cases/[id]/latest-result/route";
import { ApiError } from "@/lib/http/route-handlers";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const me = { ...EDITOR_USER, id: "user-me-1" };

function makeRequest(id: string) {
  return createMockRequest(`/api/eval-cases/${id}/latest-result`, {
    method: "GET",
  });
}

describe("GET /api/eval-cases/[id]/latest-result — visibility enforcement", () => {
  const mockSession = createMockSession(me);

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(mockSession);
  });

  it("1. returns the latest result for a visible case", async () => {
    loadCaseMock.mockResolvedValue({ caseRow: { id: 42 }, suite: { id: "suite-1" } });
    getLatestCaseResultMock.mockResolvedValue({ score: 88, assertionResults: [] });

    const res = await GET(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.score).toBe(88);
    expect(loadCaseMock).toHaveBeenCalledWith(42, mockSession);
  });

  it("2. foreign private cases are opaque 404 (via loadCase), result never queried", async () => {
    loadCaseMock.mockRejectedValue(new ApiError("NOT_FOUND", 404, "Eval case not found."));

    const res = await GET(makeRequest("99"), { params: Promise.resolve({ id: "99" }) });
    expect(res.status).toBe(404);
    expect(getLatestCaseResultMock).not.toHaveBeenCalled();
  });

  it("3. non-numeric ids are rejected with 400 before any query", async () => {
    const res = await GET(makeRequest("abc"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(400);
    expect(loadCaseMock).not.toHaveBeenCalled();
    expect(getLatestCaseResultMock).not.toHaveBeenCalled();
  });
});
