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
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  return {
    dbMock: {
      select: vi.fn().mockReturnValue(queryMock),
      insert: vi.fn().mockReturnValue(queryMock),
      update: vi.fn().mockReturnValue(queryMock),
      delete: vi.fn().mockReturnValue(queryMock),
      transaction: vi.fn(async (callback) => callback(dbMock)),
      _queryMock: queryMock,
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

import { NextRequest } from "next/server";
import { GET as listAgents, POST as createAgent } from "@/app/api/builtin-agents/route";
import {
  PATCH as updateAgent,
  DELETE as deleteAgent,
} from "@/app/api/builtin-agents/[id]/route";
import { SUPERVISOR_NAME, SUPERVISOR_DESCRIPTION } from "@/lib/constants/supervisor";

const TEST_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("Builtin Agents API — RBAC & Security Boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Authentication & RBAC Enforcement", () => {
    it("rejects unauthenticated requests on GET with 401", async () => {
      getSessionMock.mockResolvedValue(null);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents");
      const res = await listAgents(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe("UNAUTHENTICATED");
    });

    it("rejects normal 'user' role on POST with 403 Forbidden", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "user-1", role: "user", email: "user@example.com" },
        session: { id: "sess-1" },
      });

      const req = new NextRequest("http://localhost:9300/api/builtin-agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "My Custom Agent",
          model: "gpt-4o",
          modelProvider: "openai",
          credentialId: TEST_UUID,
        }),
      });

      const res = await createAgent(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("FORBIDDEN");
    });

    it("allows 'editor' role to create custom agent", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "editor-1", role: "editor", email: "editor@example.com" },
        session: { id: "sess-1" },
      });

      const createdAgent = {
        id: "223e4567-e89b-12d3-a456-426614174000",
        name: "Test Agent",
        model: "gpt-4o",
        modelProvider: "openai",
        credentialId: TEST_UUID,
        createdBy: "editor-1",
        visibility: "private",
      };

      dbMock._queryMock.returning.mockResolvedValueOnce([createdAgent]);

      const req = new NextRequest("http://localhost:9300/api/builtin-agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test Agent",
          model: "gpt-4o",
          modelProvider: "openai",
          credentialId: TEST_UUID,
        }),
      });

      const res = await createAgent(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe(createdAgent.id);
    });
  });

  describe("Supervisor Role & Identity Protection", () => {
    it("overwrites name, description and prompt when creating a supervisor agent", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "admin@example.com" },
        session: { id: "sess-1" },
      });

      let insertedValues: Record<string, unknown> | null = null;
      dbMock.insert.mockImplementationOnce(() => ({
        values: vi.fn((vals: Record<string, unknown>) => {
          insertedValues = vals;
          return {
            returning: vi.fn().mockResolvedValueOnce([{ id: "sup-1", ...vals }]),
          };
        }),
      }));

      const req = new NextRequest("http://localhost:9300/api/builtin-agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Fake Supervisor Name",
          description: "Fake description",
          role: "supervisor",
          model: "gpt-4o",
          modelProvider: "openai",
          credentialId: TEST_UUID,
        }),
      });

      const res = await createAgent(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(201);
      expect(insertedValues).not.toBeNull();
      expect(insertedValues!["name"]).toBe(SUPERVISOR_NAME);
      expect(insertedValues!["description"]).toBe(SUPERVISOR_DESCRIPTION);
    });

    it("rejects renaming or modifying identity of an existing supervisor agent", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "admin@example.com" },
        session: { id: "sess-1" },
      });

      dbMock._queryMock.limit.mockResolvedValueOnce([
        {
          id: "sup-1",
          createdBy: "admin-1",
          visibility: "private",
          role: "supervisor",
          name: SUPERVISOR_NAME,
          description: SUPERVISOR_DESCRIPTION,
          prompt: "supervisor instructions",
        },
      ]);

      const req = new NextRequest(
        "http://localhost:9300/api/builtin-agents/sup-1",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Hacked Nango Name",
          }),
        },
      );

      const res = await updateAgent(req, { params: Promise.resolve({ id: "sup-1" }) });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.message).toMatch(/Supervisor identity is locked/i);
    });
  });

  describe("Resource Permissions & Deletion Guard", () => {
    it("prevents non-owner editor from deleting another user's private agent", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "editor-attacker", role: "editor", email: "attacker@example.com" },
        session: { id: "sess-1" },
      });

      dbMock._queryMock.limit.mockResolvedValueOnce([
        {
          id: "victim-agent",
          createdBy: "user-victim",
          visibility: "private",
        },
      ]);

      const req = new NextRequest(
        "http://localhost:9300/api/builtin-agents/victim-agent",
        { method: "DELETE" },
      );

      const res = await deleteAgent(req, { params: Promise.resolve({ id: "victim-agent" }) });
      expect(res.status).toBe(403);
      expect(dbMock.delete).not.toHaveBeenCalled();
    });

    it("allows admin or creator to delete agent and triggers cache invalidation", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "admin@example.com" },
        session: { id: "sess-1" },
      });

      dbMock._queryMock.limit.mockResolvedValueOnce([
        {
          id: "victim-agent",
          createdBy: "user-victim",
          visibility: "private",
        },
      ]);

      const req = new NextRequest(
        "http://localhost:9300/api/builtin-agents/victim-agent",
        { method: "DELETE" },
      );

      const res = await deleteAgent(req, { params: Promise.resolve({ id: "victim-agent" }) });
      expect(res.status).toBe(204);
      expect(dbMock.delete).toHaveBeenCalled();
      expect(invalidateForAgentChangeMock).toHaveBeenCalledWith("victim-agent");
    });
  });
});
