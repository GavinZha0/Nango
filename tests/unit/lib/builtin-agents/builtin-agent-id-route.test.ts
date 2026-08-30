import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-test-123",
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

const { invalidateForAgentChangeMock } = vi.hoisted(() => ({
  invalidateForAgentChangeMock: vi.fn(),
}));

vi.mock("@/lib/cache/invalidation", () => ({
  invalidateForAgentChange: invalidateForAgentChangeMock,
}));

const { dbMock } = vi.hoisted(() => {
  const queryMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
  };
  return {
    dbMock: {
      select: vi.fn().mockReturnValue(queryMock),
      update: vi.fn().mockReturnValue(queryMock),
      insert: vi.fn().mockReturnValue(queryMock),
      delete: vi.fn().mockReturnValue(queryMock),
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(dbMock)),
      _queryMock: queryMock,
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

import { NextRequest } from "next/server";
import { GET, PATCH, DELETE } from "@/app/api/builtin-agents/[id]/route";

describe("Built-in Agent ID Route — /api/builtin-agents/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "user@nango.dev", role: "editor" },
      session: { id: "sess-1", userId: "user-1" },
    });
  });

  describe("GET /api/builtin-agents/[id]", () => {
    it("returns 404 when agent is not found or not visible to user", async () => {
      dbMock._queryMock.limit.mockResolvedValueOnce([]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-1");
      const res = await GET(req, { params: Promise.resolve({ id: "agent-1" }) });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.message).toMatch(/Agent not found/i);
    });

    it("returns 200 with agent details and joined bound tools", async () => {
      const mockAgent = {
        id: "agent-1",
        name: "Research Assistant",
        visibility: "public",
        createdBy: "user-1",
      };
      const mockTools = [
        {
          id: 1,
          toolType: "skill",
          skillId: "skill-1",
          skillName: "Web Search",
          order: 0,
        },
      ];

      dbMock._queryMock.limit.mockResolvedValueOnce([mockAgent]);
      dbMock._queryMock.orderBy.mockResolvedValueOnce(mockTools);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-1");
      const res = await GET(req, { params: Promise.resolve({ id: "agent-1" }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.name).toBe("Research Assistant");
      expect(json.tools).toEqual(mockTools);
    });
  });

  describe("PATCH /api/builtin-agents/[id]", () => {
    it("returns 409 when attempting to change an immutable role", async () => {
      const existingAgent = {
        id: "agent-1",
        name: "Evaluator Agent",
        role: "evaluator",
        visibility: "private",
        createdBy: "user-1",
      };
      dbMock._queryMock.limit.mockResolvedValueOnce([existingAgent]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "secretary" }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "agent-1" }) });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.message).toMatch(/Agent role is immutable once set/i);
    });

    it("returns 409 when attempting to modify Supervisor name or prompt", async () => {
      const existingSupervisor = {
        id: "agent-sup",
        name: "Nango",
        role: "supervisor",
        description: "Orchestrator",
        prompt: "Canonical prompt",
        visibility: "public",
        createdBy: "user-1",
      };
      dbMock._queryMock.limit.mockResolvedValueOnce([existingSupervisor]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-sup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Custom Name", prompt: "Hacked Prompt" }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "agent-sup" }) });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.message).toMatch(/Supervisor identity is locked/i);
    });

    it("returns 403 when non-owner editor tries to change visibility or enabled state", async () => {
      const otherUserAgent = {
        id: "agent-other",
        name: "Shared Agent",
        role: null,
        visibility: "public",
        createdBy: "user-999", // Different user
      };
      dbMock._queryMock.limit.mockResolvedValueOnce([otherUserAgent]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-other", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "agent-other" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.message).toMatch(/Only the creator or an admin can change visibility/i);
    });

    it("updates agent properties successfully and invalidates cache", async () => {
      const myAgent = {
        id: "agent-me",
        name: "Old Name",
        role: null,
        description: "Old Desc",
        visibility: "private",
        createdBy: "user-1",
      };
      const updatedAgent = {
        ...myAgent,
        name: "New Name",
        description: "New Desc",
      };

      dbMock._queryMock.limit.mockResolvedValueOnce([myAgent]);
      dbMock._queryMock.returning.mockResolvedValueOnce([updatedAgent]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name", description: "New Desc" }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "agent-me" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.name).toBe("New Name");
      expect(invalidateForAgentChangeMock).toHaveBeenCalledWith("agent-me");
    });
  });

  describe("DELETE /api/builtin-agents/[id]", () => {
    it("returns 403 when non-owner editor tries to delete another user's agent", async () => {
      const otherUserAgent = {
        id: "agent-del-1",
        visibility: "private",
        createdBy: "user-someone-else",
      };
      dbMock._queryMock.limit.mockResolvedValueOnce([otherUserAgent]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-del-1", {
        method: "DELETE",
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: "agent-del-1" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.message).toMatch(/Only the creator or an admin can delete/i);
      expect(invalidateForAgentChangeMock).not.toHaveBeenCalled();
    });

    it("deletes owner agent cleanly and returns 204", async () => {
      const myAgent = {
        id: "agent-del-2",
        visibility: "private",
        createdBy: "user-1",
      };
      dbMock._queryMock.limit.mockResolvedValueOnce([myAgent]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents/agent-del-2", {
        method: "DELETE",
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: "agent-del-2" }) });
      expect(res.status).toBe(204);
      expect(invalidateForAgentChangeMock).toHaveBeenCalledWith("agent-del-2");
    });
  });
});
