import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock, selectMock, insertMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  selectMock: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-web-auto-123",
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
    select: selectMock,
    insert: insertMock,
  },
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/web-auto-suites/[id]/cases/route";

describe("GET & POST /api/web-auto-suites/[id]/cases", () => {
  const user = {
    id: "user-editor-1",
    email: "editor@example.com",
    name: "Editor",
    role: "editor",
  };

  const otherUser = {
    id: "user-other-1",
    email: "other@example.com",
    name: "Other",
    role: "editor",
  };

  const validSuiteId = "11111111-1111-4111-a111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/web-auto-suites/[id]/cases", () => {
    it("1. returns cases list for valid suite (200 OK)", async () => {
      getSessionMock.mockResolvedValue({
        user,
        session: { id: "sess-1", userId: user.id },
      });

      const mockSuite = {
        visibility: "private",
        createdBy: user.id,
      };

      const mockCases = [
        { id: 1, suiteId: validSuiteId, name: "case_a", description: null, scriptContent: "await page.goto('/')", assertions: [], enabled: true },
        { id: 2, suiteId: validSuiteId, name: "case_b", description: null, scriptContent: "await page.click('button')", assertions: [], enabled: true },
      ];

      selectMock.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            // First call is suite lookup, second is cases list
            return {
              orderBy: vi.fn().mockResolvedValue(mockCases),
              then: (resolve: (val: unknown) => void) => resolve([mockSuite]),
            };
          }),
        }),
      }));

      const req = new NextRequest(`http://localhost/api/web-auto-suites/${validSuiteId}/cases`, { method: "GET" });
      const res = await GET(req, { params: Promise.resolve({ id: validSuiteId }) });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it("2. returns 404 for invalid UUID format", async () => {
      getSessionMock.mockResolvedValue({
        user,
        session: { id: "sess-1", userId: user.id },
      });

      const req = new NextRequest("http://localhost/api/web-auto-suites/invalid-uuid/cases", { method: "GET" });
      const res = await GET(req, { params: Promise.resolve({ id: "invalid-uuid" }) });

      expect(res.status).toBe(404);
    });

    it("3. returns 403 when access denied to private suite", async () => {
      getSessionMock.mockResolvedValue({
        user: otherUser,
        session: { id: "sess-2", userId: otherUser.id },
      });

      const mockSuite = {
        visibility: "private",
        createdBy: user.id, // created by someone else
      };

      selectMock.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockSuite]),
        }),
      }));

      const req = new NextRequest(`http://localhost/api/web-auto-suites/${validSuiteId}/cases`, { method: "GET" });
      const res = await GET(req, { params: Promise.resolve({ id: validSuiteId }) });

      expect(res.status).toBe(404); // Unified visibility: non-visible returns 404
    });
  });

  describe("POST /api/web-auto-suites/[id]/cases", () => {
    it("1. creates a new case in the suite (201 Created)", async () => {
      getSessionMock.mockResolvedValue({
        user,
        session: { id: "sess-1", userId: user.id },
      });

      const mockSuite = {
        visibility: "private",
        createdBy: user.id,
      };

      selectMock.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockSuite]),
        }),
      }));

      const createdRow = {
        id: 10,
        suiteId: validSuiteId,
        name: "test_checkout_flow",
        description: "Test checkout",
        scriptContent: "console.log('run')",
        assertions: [],
        enabled: true,
      };

      insertMock.mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdRow]),
        }),
      }));

      const req = new NextRequest(`http://localhost/api/web-auto-suites/${validSuiteId}/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test_checkout_flow",
          description: "Test checkout",
          scriptContent: "console.log('run')",
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: validSuiteId }) });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe("test_checkout_flow");
    });

    it("2. returns 409 Conflict when case name already exists", async () => {
      getSessionMock.mockResolvedValue({
        user,
        session: { id: "sess-1", userId: user.id },
      });

      const mockSuite = {
        visibility: "private",
        createdBy: user.id,
      };

      selectMock.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockSuite]),
        }),
      }));

      const pgUniqueError = Object.assign(
        new Error("duplicate key value violates unique constraint"),
        { code: "23505" },
      );

      insertMock.mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(pgUniqueError),
        }),
      }));

      const req = new NextRequest(`http://localhost/api/web-auto-suites/${validSuiteId}/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test_checkout_flow",
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: validSuiteId }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.message).toContain("already exists in this suite");
    });
  });
});
