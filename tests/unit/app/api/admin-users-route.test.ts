import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { createMockSession, ADMIN_USER } from "tests/unit/fixtures";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
const dbMock = db as unknown as MockDrizzleDb;

import { GET as listUsers } from "@/app/api/admin/users/route";

describe("Admin Users API — Route Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
  });

  describe("RBAC Access Guard", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getSessionMock.mockResolvedValue(null);

      const req = createMockRequest("/api/admin/users");
      const res = await listUsers(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe("UNAUTHENTICATED");
    });

    it("rejects non-admin roles (user / editor) with 403 Forbidden", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "editor-1", role: "editor", email: "editor@example.com" },
        session: { id: "sess-1" },
      });

      const req = createMockRequest("/api/admin/users");
      const res = await listUsers(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("FORBIDDEN");
    });
  });

  describe("Unpaginated Full Fetch Mode (Default)", () => {
    it("fetches all active users without limit/offset clauses or count(*) overhead", async () => {
      getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));

      const mockUserList = [
        { id: "u-1", name: "Alice", email: "alice@example.com", role: "admin" },
        { id: "u-2", name: "Bob", email: "bob@example.com", role: "user" },
      ];

      dbMock.$resolveWith(mockUserList);

      const req = createMockRequest("/api/admin/users");
      const res = await listUsers(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.users).toHaveLength(2);
      expect(json.total).toBe(2);
      expect(json.limit).toBeNull();
      expect(json.offset).toBe(0);

      // Verify limit and offset were NOT called on the query chain
      expect(dbMock._chain.limit).not.toHaveBeenCalled();
      expect(dbMock._chain.offset).not.toHaveBeenCalled();

      // Verify only 1 select query was initiated (no count(*) query)
      expect(dbMock.select).toHaveBeenCalledTimes(1);
    });
  });

  describe("Paginated Mode (with limit query param)", () => {
    it("applies limit/offset and performs count(*) query when limit is provided", async () => {
      getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));

      const mockUserList = [
        { id: "u-1", name: "Alice", email: "alice@example.com", role: "admin" },
      ];
      const countResult = [{ c: 10 }];

      // Enqueue first query (users) and second query (count)
      dbMock.$enqueue(mockUserList, countResult);

      const req = createMockRequest("/api/admin/users?limit=1&offset=2");
      const res = await listUsers(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.users).toHaveLength(1);
      expect(json.total).toBe(10);
      expect(json.limit).toBe(1);
      expect(json.offset).toBe(2);

      // Verify limit and offset WERE called on the query chain
      expect(dbMock._chain.limit).toHaveBeenCalledWith(1);
      expect(dbMock._chain.offset).toHaveBeenCalledWith(2);

      // Verify 2 select queries were executed (users + count)
      expect(dbMock.select).toHaveBeenCalledTimes(2);
    });
  });
});
