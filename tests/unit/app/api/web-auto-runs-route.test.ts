import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock, startWebAutoSuiteRunMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  startWebAutoSuiteRunMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-web-auto-runs-123",
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

vi.mock("@/lib/web-auto/orchestrator", () => ({
  startWebAutoSuiteRun: startWebAutoSuiteRunMock,
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/web-auto-runs/route";
import { db } from "@/lib/db";

const SUITE_ID = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const me = { id: "user-me-1", email: "me@example.com", name: "Me", role: "editor" };

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/web-auto-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suiteId: SUITE_ID }),
  });
}

describe("POST /api/web-auto-runs — run gate (F7-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: me });
    startWebAutoSuiteRunMock.mockResolvedValue({ runId: "run-1", totalCount: 3 });
  });

  it("1. foreign private suites are opaque 404", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: SUITE_ID, visibility: "private", createdBy: "user-other-1", enabled: true, mcpServerId: SERVER_ID },
        ]),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    expect(startWebAutoSuiteRunMock).not.toHaveBeenCalled();
  });

  it("2. disabled suites are rejected with 400 even for the author", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: SUITE_ID, visibility: "private", createdBy: me.id, enabled: false, mcpServerId: SERVER_ID },
        ]),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(startWebAutoSuiteRunMock).not.toHaveBeenCalled();
  });

  it("3. suites without a Playwright binding are rejected with 400", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: SUITE_ID, visibility: "private", createdBy: me.id, enabled: true, mcpServerId: null },
        ]),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(startWebAutoSuiteRunMock).not.toHaveBeenCalled();
  });

  it("4. authors can run their own enabled bound suites (202)", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: SUITE_ID, visibility: "private", createdBy: me.id, enabled: true, mcpServerId: SERVER_ID },
        ]),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(202);
    expect(startWebAutoSuiteRunMock).toHaveBeenCalledWith({
      suiteId: SUITE_ID,
      ownerId: me.id,
    });
  });

  it("5. collaborators can run public suites (editor = edit on public)", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: SUITE_ID, visibility: "public", createdBy: "user-other-1", enabled: true, mcpServerId: SERVER_ID },
        ]),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const res = await POST(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(202);
  });
});
