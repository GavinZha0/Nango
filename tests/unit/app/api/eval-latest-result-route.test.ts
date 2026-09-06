import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock, loadCaseMock, getLatestCaseResultMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  loadCaseMock: vi.fn(),
  getLatestCaseResultMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-eval-latest-result-123",
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

vi.mock("@/lib/evaluation/access", () => ({
  loadCase: loadCaseMock,
}));

vi.mock("@/lib/evaluation/storage", () => ({
  getLatestCaseResult: getLatestCaseResultMock,
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/eval-cases/[id]/latest-result/route";
import { ApiError } from "@/lib/http/route-handlers";

const me = { id: "user-me-1", email: "me@example.com", name: "Me", role: "editor" };

function makeRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/eval-cases/${id}/latest-result`, {
    method: "GET",
  });
}

describe("GET /api/eval-cases/[id]/latest-result — visibility enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: me });
  });

  it("1. returns the latest result for a visible case", async () => {
    loadCaseMock.mockResolvedValue({ caseRow: { id: 42 }, suite: { id: "suite-1" } });
    getLatestCaseResultMock.mockResolvedValue({ score: 88, assertionResults: [] });

    const res = await GET(makeRequest("42"), { params: Promise.resolve({ id: "42" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.score).toBe(88);
    expect(loadCaseMock).toHaveBeenCalledWith(42, { user: me });
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
