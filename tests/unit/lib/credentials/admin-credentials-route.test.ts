import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";

vi.mock("server-only", () => ({}));

const KEY_K1: string = randomBytes(32).toString("hex");
process.env.CREDENTIAL_ENCRYPTION_KEYRING = `k1=${KEY_K1}`;
process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = "k1";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/observability/logger", () => ({
  newRequestId: () => "req-test-cred-123",
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

const { invalidateForCredentialChangeMock } = vi.hoisted(() => ({
  invalidateForCredentialChangeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidation", () => ({
  invalidateForCredentialChange: invalidateForCredentialChangeMock,
}));

const { dbMock } = vi.hoisted(() => {
  const queryMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    as: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    then: vi.fn(),
  };
  return {
    dbMock: {
      select: vi.fn().mockReturnValue(queryMock),
      insert: vi.fn().mockReturnValue(queryMock),
      update: vi.fn().mockReturnValue(queryMock),
      delete: vi.fn().mockReturnValue(queryMock),
      _queryMock: queryMock,
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

import { NextRequest } from "next/server";
import { GET as listCredentials, POST as createCredential } from "@/app/api/admin/credentials/route";
import { DELETE as deleteCredential } from "@/app/api/admin/credentials/[id]/route";

const TEST_CRED_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("Admin Credentials API — Security & Data Protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("RBAC Access Guard", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getSessionMock.mockResolvedValue(null);

      const req = new NextRequest("http://localhost:9300/api/admin/credentials");
      const res = await listCredentials(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe("UNAUTHENTICATED");
    });

    it("rejects non-admin roles (user / editor) with 403 Forbidden", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "editor-1", role: "editor", email: "editor@example.com" },
        session: { id: "sess-1" },
      });

      const req = new NextRequest("http://localhost:9300/api/admin/credentials");
      const res = await listCredentials(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("FORBIDDEN");
    });
  });

  describe("Secret Masking & Key Preview on Creation", () => {
    it("creates credential with encrypted payload and returns masked preview without plaintext secret", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "admin@example.com" },
        session: { id: "sess-1" },
      });

      const savedCred = {
        id: TEST_CRED_ID,
        name: "OpenAI Prod Key",
        type: "api_key",
        serviceType: "llm",
        provider: "openai",
        metadata: { keyPreview: "...3456" },
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      dbMock._queryMock.returning.mockResolvedValueOnce([savedCred]);

      const req = new NextRequest("http://localhost:9300/api/admin/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "OpenAI Prod Key",
          type: "api_key",
          serviceType: "llm",
          provider: "openai",
          payload: { apiKey: "sk-proj-super-secret-key-123456" },
        }),
      });

      const res = await createCredential(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(201);
      const data = await res.json();

      // Verified: response does not contain raw payload or encrypted ciphertext
      expect(data.payload).toBeUndefined();
      expect(data.encryptedPayload).toBeUndefined();
      expect(data.metadata?.keyPreview).toBeDefined();
    });
  });

  describe("Dependency Protection & Deletion Safety", () => {
    it("blocks deleting credential with 409 CONFLICT if in use by agents or MCP servers", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "admin@example.com" },
        session: { id: "sess-1" },
      });

      // Mock agentUsage = 2, mcpUsage = 1
      dbMock.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }]),
          }),
        });

      const req = new NextRequest(
        `http://localhost:9300/api/admin/credentials/${TEST_CRED_ID}`,
        { method: "DELETE" },
      );

      const res = await deleteCredential(req, {
        params: Promise.resolve({ id: TEST_CRED_ID }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe("CONFLICT");
      expect(json.message).toContain("This credential is in use");
      expect(json.details?.usages).toHaveLength(2);
      expect(dbMock.delete).not.toHaveBeenCalled();
    });

    it("allows deletion when no dependencies exist and invalidates cache", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "admin@example.com" },
        session: { id: "sess-1" },
      });

      // Mock agentUsage = 0, mcpUsage = 0
      dbMock.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        });

      dbMock._queryMock.returning.mockResolvedValueOnce([{ id: TEST_CRED_ID }]);

      const req = new NextRequest(
        `http://localhost:9300/api/admin/credentials/${TEST_CRED_ID}`,
        { method: "DELETE" },
      );

      const res = await deleteCredential(req, {
        params: Promise.resolve({ id: TEST_CRED_ID }),
      });

      expect(res.status).toBe(204);
      expect(dbMock.delete).toHaveBeenCalled();
      expect(invalidateForCredentialChangeMock).toHaveBeenCalledWith(TEST_CRED_ID);
    });
  });
});
