import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock server-only (it throws when imported outside Next.js server context)
vi.mock("server-only", () => ({}));

// Mock the DB module
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

// Mock logger to suppress expected ERROR output during decryption-failure tests
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Mock config service (lookup.ts imports getConfigMs)
vi.mock("@/lib/config", () => ({
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
}));

// Mock the crypto module
vi.mock("@/lib/credentials/crypto", () => ({
  decrypt: vi.fn((ciphertext: string) => {
    if (ciphertext === "valid-encrypted") return { token: "decrypted-token" };
    if (ciphertext === "key-only") return { key: "my-api-key" };
    if (ciphertext === "bad-payload") return { foo: "bar" };
    throw new Error("decryption failed");
  }),
}));

// Mock the schema module
vi.mock("@/lib/db/schema", () => ({
  CredentialTable: {
    id: "id",
    encryptedPayload: "encrypted_payload",
    restUrl: "rest_url",
    aguiUrl: "agui_url",
    provider: "provider",
    enabled: "enabled",
    serviceType: "service_type",
    createdAt: "created_at",
    name: "name",
  },
}));

// Mock backends/types for isSupportedBackend (used by getAgentCredentialConfigById)
vi.mock("@/lib/backends/types", () => ({
  isSupportedBackend: (v: unknown) => v === "agno" || v === "mastra" || v === "dify",
}));

const {
  invalidateCredentialCache,
  getCredentialConfigById,
  getAgentCredentialConfigById,
  getAllAgentCredentials,
  getCredentialTokenById,
  onCredentialCacheInvalidated,
} = await import("@/lib/credentials/lookup");
const { db } = await import("@/lib/db");

// Helper to mock the chained query builder (select → from → where → limit)
function mockDbQuery(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

describe("invalidateCredentialCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCredentialCache();
  });

  it("is a function that does not throw", () => {
    expect(() => invalidateCredentialCache()).not.toThrow();
  });

  it("can be called multiple times", () => {
    invalidateCredentialCache();
    invalidateCredentialCache();
    // no error = pass
  });
});

describe("getCredentialConfigById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCredentialCache();
  });

  it("returns null when credential not found", async () => {
    mockDbQuery([]);
    const result = await getCredentialConfigById("non-existent-id");
    expect(result).toBeNull();
  });

  it("returns full config with decrypted token", async () => {
    mockDbQuery([{
      id: "cred-1",
      encryptedPayload: "valid-encrypted",
      restUrl: "http://localhost:7878",
      aguiUrl: "http://localhost:7878/agui/{agentId}/agui",
      provider: "agno",
    }]);

    const result = await getCredentialConfigById("cred-1");
    expect(result).toEqual({
      id: "cred-1",
      token: "decrypted-token",
      restUrl: "http://localhost:7878",
      aguiUrl: "http://localhost:7878/agui/{agentId}/agui",
      provider: "agno",
    });
  });

  it("returns null token when decryption fails", async () => {
    mockDbQuery([{
      id: "cred-bad",
      encryptedPayload: "corrupt-data",
      restUrl: null,
      aguiUrl: null,
      provider: "agno",
    }]);

    const result = await getCredentialConfigById("cred-bad");
    expect(result).not.toBeNull();
    expect(result!.token).toBeNull();
  });

  it("serves from cache on second call (no additional DB query)", async () => {
    mockDbQuery([{
      id: "cred-1",
      encryptedPayload: "valid-encrypted",
      restUrl: "http://localhost:7878",
      aguiUrl: null,
      provider: "agno",
    }]);

    await getCredentialConfigById("cred-1");
    const selectSpy = vi.mocked(db.select);
    const callsBefore = selectSpy.mock.calls.length;

    await getCredentialConfigById("cred-1");
    expect(selectSpy.mock.calls.length).toBe(callsBefore); // no new DB call
  });
});

// ── getAgentCredentialConfigById ─────────────────────────────────────

describe("getAgentCredentialConfigById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCredentialCache();
  });

  it("returns config for valid agent credential (supported backend)", async () => {
    mockDbQuery([{
      id: "agent-cred-1",
      encryptedPayload: "valid-encrypted",
      restUrl: "http://localhost:7878",
      aguiUrl: "http://localhost:7878/agui/{agentId}/agui",
      provider: "agno",
    }]);

    const result = await getAgentCredentialConfigById("agent-cred-1");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("agno");
    expect(result!.token).toBe("decrypted-token");
  });

  it("returns null for unsupported backend provider", async () => {
    mockDbQuery([{
      id: "cred-unsupported",
      encryptedPayload: "valid-encrypted",
      restUrl: "http://localhost",
      aguiUrl: null,
      provider: "unknown-platform",
    }]);

    const result = await getAgentCredentialConfigById("cred-unsupported");
    expect(result).toBeNull();
  });

  it("returns null when no rows match (disabled or non-agent)", async () => {
    mockDbQuery([]);
    const result = await getAgentCredentialConfigById("no-match");
    expect(result).toBeNull();
  });

  it("always queries DB (intentionally bypasses cache for security)", async () => {
    mockDbQuery([{
      id: "agent-cred-1",
      encryptedPayload: "valid-encrypted",
      restUrl: "http://localhost:7878",
      aguiUrl: null,
      provider: "agno",
    }]);

    await getAgentCredentialConfigById("agent-cred-1");
    const callsAfterFirst = vi.mocked(db.select).mock.calls.length;

    mockDbQuery([{
      id: "agent-cred-1",
      encryptedPayload: "valid-encrypted",
      restUrl: "http://localhost:7878",
      aguiUrl: null,
      provider: "agno",
    }]);
    await getAgentCredentialConfigById("agent-cred-1");

    // Should have made a second DB call (no cache read)
    expect(vi.mocked(db.select).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

// ── getAllAgentCredentials ───────────────────────────────────────────

describe("getAllAgentCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCredentialCache();
  });

  it("returns all enabled agent credentials", async () => {
    mockDbQuery([
      { id: "c1", encryptedPayload: "valid-encrypted", restUrl: "http://a", aguiUrl: null, provider: "agno" },
      { id: "c2", encryptedPayload: "key-only", restUrl: "http://b", aguiUrl: null, provider: "mastra" },
    ]);

    const result = await getAllAgentCredentials();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("c1");
    expect(result[1].id).toBe("c2");
  });

  it("caches result — second call does not hit DB", async () => {
    mockDbQuery([
      { id: "c1", encryptedPayload: "valid-encrypted", restUrl: "http://a", aguiUrl: null, provider: "agno" },
    ]);

    await getAllAgentCredentials();
    const callsBefore = vi.mocked(db.select).mock.calls.length;

    await getAllAgentCredentials();
    expect(vi.mocked(db.select).mock.calls.length).toBe(callsBefore);
  });

  it("cross-fills configByIdCache so per-id lookups hit", async () => {
    mockDbQuery([
      { id: "c1", encryptedPayload: "valid-encrypted", restUrl: "http://a", aguiUrl: null, provider: "agno" },
    ]);

    await getAllAgentCredentials();

    // Now getCredentialConfigById should hit cache (no new DB query)
    const callsBefore = vi.mocked(db.select).mock.calls.length;
    const byId = await getCredentialConfigById("c1");
    expect(byId).not.toBeNull();
    expect(byId!.id).toBe("c1");
    expect(vi.mocked(db.select).mock.calls.length).toBe(callsBefore);
  });
});

// ── getCredentialTokenById ──────────────────────────────────────────

describe("getCredentialTokenById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCredentialCache();
  });

  it("returns token and provider", async () => {
    mockDbQuery([{
      encryptedPayload: "valid-encrypted",
      provider: "agno",
    }]);

    const result = await getCredentialTokenById("cred-1");
    expect(result.token).toBe("decrypted-token");
    expect(result.provider).toBe("agno");
  });

  it("returns null token/provider when not found", async () => {
    mockDbQuery([]);
    const result = await getCredentialTokenById("nope");
    expect(result.token).toBeNull();
    expect(result.provider).toBeNull();
  });
});

// ── onCredentialCacheInvalidated (subscriber pattern) ───────────────

describe("onCredentialCacheInvalidated", () => {
  it("calls subscribers when cache is invalidated", () => {
    const subscriber = vi.fn();
    onCredentialCacheInvalidated(subscriber);
    invalidateCredentialCache();
    expect(subscriber).toHaveBeenCalledOnce();
  });
});
