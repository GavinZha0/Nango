import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock, selectMock, insertMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  selectMock: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: selectMock,
    insert: insertMock,
  },
}));

import { GET, POST } from "@/app/api/web-auto-suites/[id]/cases/route";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockWebAutoSuite } from "tests/unit/fixtures";

describe("GET & POST /api/web-auto-suites/[id]/cases", () => {
  const user = EDITOR_USER;

  const otherUser = {
    id: "user-other-1",
    email: "other@example.com",
    name: "Other",
    role: "editor" as const,
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

      const mockSuite = createMockWebAutoSuite({
        id: validSuiteId,
        visibility: "private",
        createdBy: user.id,
      });

      const mockCases = [
        { id: 1, suiteId: validSuiteId, name: "case_a", input: { script: "await page.goto('/')", steps: "1. Goto" }, assertions: [], enabled: true },
        { id: 2, suiteId: validSuiteId, name: "case_b", input: { script: "await page.click('button')", steps: "2. Click" }, assertions: [], enabled: true },
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

      const req = createMockRequest(`/api/web-auto-suites/${validSuiteId}/cases`, { method: "GET" });
      const res = await GET(req, { params: Promise.resolve({ id: validSuiteId }) });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("case_a");
    });

    it("2. returns 404 for invalid UUID format", async () => {
      getSessionMock.mockResolvedValue({
        user,
        session: { id: "sess-1", userId: user.id },
      });

      const req = createMockRequest("/api/web-auto-suites/invalid-uuid/cases", { method: "GET" });
      const res = await GET(req, { params: Promise.resolve({ id: "invalid-uuid" }) });

      expect(res.status).toBe(404);
    });

    it("3. returns 403 when access denied to private suite", async () => {
      getSessionMock.mockResolvedValue({
        user: otherUser,
        session: { id: "sess-2", userId: otherUser.id },
      });

      const mockSuite = createMockWebAutoSuite({
        id: validSuiteId,
        visibility: "private",
        createdBy: user.id, // created by someone else
      });

      selectMock.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockSuite]),
        }),
      }));

      const req = createMockRequest(`/api/web-auto-suites/${validSuiteId}/cases`, { method: "GET" });
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

      const mockSuite = createMockWebAutoSuite({
        id: validSuiteId,
        visibility: "private",
        createdBy: user.id,
      });

      selectMock.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockSuite]),
        }),
      }));

      const createdRow = {
        id: 10,
        suiteId: validSuiteId,
        name: "test_checkout_flow",
        input: {
          script: "console.log('run')",
          steps: "Test checkout",
        },
        assertions: [],
        enabled: true,
      };

      insertMock.mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdRow]),
        }),
      }));

      const req = createMockRequest(`/api/web-auto-suites/${validSuiteId}/cases`, {
        method: "POST",
        body: {
          name: "test_checkout_flow",
          input: {
            script: "console.log('run')",
            steps: "Test checkout",
          },
        },
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

      const mockSuite = createMockWebAutoSuite({
        id: validSuiteId,
        visibility: "private",
        createdBy: user.id,
      });

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

      const req = createMockRequest(`/api/web-auto-suites/${validSuiteId}/cases`, {
        method: "POST",
        body: {
          name: "test_checkout_flow",
        },
      });

      const res = await POST(req, { params: Promise.resolve({ id: validSuiteId }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.message).toContain("already exists in this suite");
    });
  });
});
