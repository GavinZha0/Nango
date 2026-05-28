import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/credentials/crypto", () => ({
  decrypt: vi.fn((ciphertext: string) => {
    if (ciphertext === "exa-payload") return { key: "exa-secret" };
    if (ciphertext === "tavily-payload") return { key: "tavily-secret" };
    if (ciphertext === "brave-payload") return { key: "brave-secret" };
    if (ciphertext === "empty-payload") return { key: "" };
    if (ciphertext === "no-key-payload") return { foo: "bar" };
    throw new Error("decryption failed");
  }),
}));

vi.mock("@/lib/db/schema", () => ({
  CredentialTable: {
    id: "id",
    encryptedPayload: "encrypted_payload",
    restUrl: "rest_url",
    provider: "provider",
    enabled: "enabled",
    serviceType: "service_type",
    createdAt: "created_at",
  },
}));

const { resolveSearchCredential } = await import("@/lib/web-search/lookup.server");
const { db } = await import("@/lib/db");

interface FakeRow {
  id: string;
  provider: string;
  restUrl: string | null;
  encryptedPayload: string;
}

function mockRows(rows: FakeRow[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

describe("resolveSearchCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns NO_PROVIDER when no rows match", async () => {
    mockRows([]);
    const result = await resolveSearchCredential();
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe("NO_PROVIDER");
    }
  });

  it("picks the Exa credential when only Exa is enabled", async () => {
    mockRows([
      { id: "c-exa", provider: "exa", restUrl: null, encryptedPayload: "exa-payload" },
    ]);
    const result = await resolveSearchCredential();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.provider).toBe("exa");
      expect(result.resolved.apiKey).toBe("exa-secret");
      expect(result.resolved.credentialId).toBe("c-exa");
      expect(result.resolved.restUrl).toBeNull();
    }
  });

  it("prefers Exa over Tavily/Brave when several are enabled", async () => {
    // Order in DB is irrelevant — PROVIDER_PRIORITY wins.
    mockRows([
      { id: "c-brave", provider: "brave", restUrl: null, encryptedPayload: "brave-payload" },
      { id: "c-tavily", provider: "tavily", restUrl: null, encryptedPayload: "tavily-payload" },
      { id: "c-exa", provider: "exa", restUrl: null, encryptedPayload: "exa-payload" },
    ]);
    const result = await resolveSearchCredential();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.provider).toBe("exa");
    }
  });

  it("falls through to Tavily when Exa payload has no key", async () => {
    mockRows([
      { id: "c-exa", provider: "exa", restUrl: null, encryptedPayload: "no-key-payload" },
      { id: "c-tavily", provider: "tavily", restUrl: null, encryptedPayload: "tavily-payload" },
    ]);
    const result = await resolveSearchCredential();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.provider).toBe("tavily");
      expect(result.resolved.apiKey).toBe("tavily-secret");
    }
  });

  it("falls through to Brave when Exa decryption fails", async () => {
    mockRows([
      { id: "c-exa-bad", provider: "exa", restUrl: null, encryptedPayload: "corrupt" },
      { id: "c-brave", provider: "brave", restUrl: null, encryptedPayload: "brave-payload" },
    ]);
    const result = await resolveSearchCredential();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.provider).toBe("brave");
    }
  });

  it("returns AUTH_MISSING when every candidate has unusable payload", async () => {
    mockRows([
      { id: "c-exa", provider: "exa", restUrl: null, encryptedPayload: "empty-payload" },
      { id: "c-tavily", provider: "tavily", restUrl: null, encryptedPayload: "no-key-payload" },
    ]);
    const result = await resolveSearchCredential();
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe("AUTH_MISSING");
    }
  });

  it("surfaces restUrl override when set", async () => {
    mockRows([
      {
        id: "c-exa",
        provider: "exa",
        restUrl: "https://proxy.internal/exa",
        encryptedPayload: "exa-payload",
      },
    ]);
    const result = await resolveSearchCredential();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.restUrl).toBe("https://proxy.internal/exa");
    }
  });
});
