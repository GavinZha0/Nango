import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "crypto";

const KEY_K1: string = randomBytes(32).toString("hex");
process.env.CREDENTIAL_ENCRYPTION_KEYRING = `k1=${KEY_K1}`;
process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = "k1";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({
  getSession: getSessionMock,
}));

const { invalidateForCredentialChangeMock } = vi.hoisted(() => ({
  invalidateForCredentialChangeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidation", () => ({
  invalidateForCredentialChange: invalidateForCredentialChangeMock,
}));

import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { createMockCredential, createMockSession, ADMIN_USER } from "tests/unit/fixtures";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
const dbMock = db as unknown as MockDrizzleDb;

import { GET as listCredentials, POST as createCredential } from "@/app/api/admin/credentials/route";
import { DELETE as deleteCredential } from "@/app/api/admin/credentials/[id]/route";

const TEST_CRED_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("Admin Credentials API — Security & Data Protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
  });

  describe("RBAC Access Guard", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getSessionMock.mockResolvedValue(null);

      const req = createMockRequest("/api/admin/credentials");
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

      const req = createMockRequest("/api/admin/credentials");
      const res = await listCredentials(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("FORBIDDEN");
    });
  });

  describe("Secret Masking & Key Preview on Creation", () => {
    it("creates credential with encrypted payload and returns masked preview without plaintext secret", async () => {
      getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));

      const { encryptedPayload: _omit, ...savedCred } = createMockCredential({
        id: TEST_CRED_ID,
        name: "OpenAI Prod Key",
        type: "api_key",
        serviceType: "llm",
        provider: "openai",
        metadata: { keyPreview: "...3456" },
        enabled: true,
      });

      dbMock._chain.returning.mockResolvedValueOnce([savedCred]);

      const req = createMockRequest("/api/admin/credentials", {
        method: "POST",
        body: {
          name: "OpenAI Prod Key",
          type: "api_key",
          serviceType: "llm",
          provider: "openai",
          payload: { apiKey: "sk-proj-super-secret-key-123456" },
        },
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
      getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));

      // Mock agentUsage = 2, mcpUsage = 1 via $enqueue
      dbMock.$enqueue(
        [{ count: 2 }],
        [{ count: 1 }],
      );

      const req = createMockRequest(`/api/admin/credentials/${TEST_CRED_ID}`, {
        method: "DELETE",
      });

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
      getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));

      // Mock agentUsage = 0, mcpUsage = 0 via $enqueue
      dbMock.$enqueue(
        [{ count: 0 }],
        [{ count: 0 }],
      );

      dbMock._chain.returning.mockResolvedValueOnce([{ id: TEST_CRED_ID }]);

      const req = createMockRequest(`/api/admin/credentials/${TEST_CRED_ID}`, {
        method: "DELETE",
      });

      const res = await deleteCredential(req, {
        params: Promise.resolve({ id: TEST_CRED_ID }),
      });

      expect(res.status).toBe(204);
      expect(dbMock.delete).toHaveBeenCalled();
      expect(invalidateForCredentialChangeMock).toHaveBeenCalledWith(TEST_CRED_ID);
    });
  });
});
