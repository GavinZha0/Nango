import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

const { invalidateForAgentChangeMock } = vi.hoisted(() => ({
  invalidateForAgentChangeMock: vi.fn(),
}));

vi.mock("@/lib/cache/invalidation", () => ({
  invalidateForAgentChange: invalidateForAgentChangeMock,
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { GET, PATCH, DELETE } from "@/app/api/builtin-agents/[id]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

const me = { ...EDITOR_USER, id: "user-1" };

describe("Built-in Agent ID Route — /api/builtin-agents/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
  });

  describe("GET /api/builtin-agents/[id]", () => {
    it("returns 404 when agent is not found or not visible to user", async () => {
      dbMock._chain.limit.mockResolvedValueOnce([]);

      const req = createMockRequest("/api/builtin-agents/agent-1");
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

      dbMock._chain.limit.mockResolvedValueOnce([mockAgent]);
      dbMock._chain.orderBy.mockResolvedValueOnce(mockTools);

      const req = createMockRequest("/api/builtin-agents/agent-1");
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
      dbMock._chain.limit.mockResolvedValueOnce([existingAgent]);

      const req = createMockRequest("/api/builtin-agents/agent-1", {
        method: "PATCH",
        body: { role: "secretary" },
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
      dbMock._chain.limit.mockResolvedValueOnce([existingSupervisor]);

      const req = createMockRequest("/api/builtin-agents/agent-sup", {
        method: "PATCH",
        body: { name: "Custom Name", prompt: "Hacked Prompt" },
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
      dbMock._chain.limit.mockResolvedValueOnce([otherUserAgent]);

      const req = createMockRequest("/api/builtin-agents/agent-other", {
        method: "PATCH",
        body: { visibility: "private" },
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

      dbMock._chain.limit.mockResolvedValueOnce([myAgent]);
      dbMock._chain.returning.mockResolvedValueOnce([updatedAgent]);

      const req = createMockRequest("/api/builtin-agents/agent-me", {
        method: "PATCH",
        body: { name: "New Name", description: "New Desc" },
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
      dbMock._chain.limit.mockResolvedValueOnce([otherUserAgent]);

      const req = createMockRequest("/api/builtin-agents/agent-del-1", {
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
      dbMock._chain.limit.mockResolvedValueOnce([myAgent]);

      const req = createMockRequest("/api/builtin-agents/agent-del-2", {
        method: "DELETE",
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: "agent-del-2" }) });
      expect(res.status).toBe(204);
      expect(invalidateForAgentChangeMock).toHaveBeenCalledWith("agent-del-2");
    });
  });
});
