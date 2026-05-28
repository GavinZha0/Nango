import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock server-only (it throws when imported outside Next.js server context)
vi.mock("server-only", () => ({}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/config", () => ({
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
}));

// Subscriber registry — the manager calls `onCredentialCacheInvalidated`
// once at module load. We capture the callback so tests can drive it.
const subscribers: Array<() => void> = [];
const getCredentialFieldsByIdMock = vi.fn();

vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialFieldsById: getCredentialFieldsByIdMock,
  onCredentialCacheInvalidated: (cb: () => void) => {
    subscribers.push(cb);
  },
}));

const {
  getOAuthAccessToken,
  getOAuthAuthorizationHeader,
  withOAuth,
  invalidateOAuthToken,
  _oauthTokenCacheSize,
} = await import("@/lib/credentials/oauth-token-manager");

// ─── Helpers ───────────────────────────────────────────────────────────

const VALID_CRED = {
  id: "cred-1",
  provider: "test",
  restUrl: null,
  fields: {
    clientId: "client-1",
    clientSecret: "secret-1",
    tokenUrl: "https://idp.example/oauth/token",
  },
};

function mockTokenEndpoint(
  responses: Array<{ ok?: boolean; status?: number; body?: unknown; throws?: Error }>,
): void {
  const fetchMock = vi.fn();
  for (const r of responses) {
    if (r.throws !== undefined) {
      fetchMock.mockRejectedValueOnce(r.throws);
      continue;
    }
    fetchMock.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: "OK",
      json: async () => r.body ?? { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 },
      text: async () => JSON.stringify(r.body ?? {}),
    });
  }
  vi.stubGlobal("fetch", fetchMock);
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  // Wipe the cache between tests so order doesn't matter.
  for (const cb of subscribers) cb();
  getCredentialFieldsByIdMock.mockReset();
  getCredentialFieldsByIdMock.mockResolvedValue(VALID_CRED);
  vi.unstubAllGlobals();
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe("getOAuthAccessToken — cache behavior", () => {
  it("hits the token endpoint on first call and caches the token", async () => {
    mockTokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }]);

    const t = await getOAuthAccessToken("cred-1");

    expect(t).toBe("tok-1");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(_oauthTokenCacheSize()).toBe(1);
  });

  it("second call within freshness window returns cached token (no extra fetch)", async () => {
    mockTokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }]);

    await getOAuthAccessToken("cred-1");
    const t2 = await getOAuthAccessToken("cred-1");

    expect(t2).toBe("tok-1");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when cached token is within 60s of expiry", async () => {
    mockTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 30 } }, // expires in 30s → inside skew
      { body: { access_token: "tok-2", expires_in: 3600 } },
    ]);

    const t1 = await getOAuthAccessToken("cred-1");
    expect(t1).toBe("tok-1");

    // Second call should NOT return cached "tok-1" because 30s < 60s skew.
    const t2 = await getOAuthAccessToken("cred-1");
    expect(t2).toBe("tok-2");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share a single in-flight token request", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi.fn().mockReturnValueOnce(fetchPromise);
    vi.stubGlobal("fetch", fetchSpy);

    // Start 5 concurrent calls.
    const calls = Promise.all([
      getOAuthAccessToken("cred-1"),
      getOAuthAccessToken("cred-1"),
      getOAuthAccessToken("cred-1"),
      getOAuthAccessToken("cred-1"),
      getOAuthAccessToken("cred-1"),
    ]);

    // Resolve the single token endpoint response.
    resolveFetch!({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ access_token: "tok-shared", expires_in: 3600 }),
      text: async () => "",
    } as Response);

    const results = await calls;
    expect(results).toEqual(["tok-shared", "tok-shared", "tok-shared", "tok-shared", "tok-shared"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getOAuthAccessToken — token endpoint errors", () => {
  it("throws when token endpoint returns non-2xx", async () => {
    mockTokenEndpoint([{ ok: false, status: 401, body: { error: "invalid_client" } }]);

    await expect(getOAuthAccessToken("cred-1")).rejects.toThrow(/401/);
  });

  it("throws when token endpoint returns no access_token", async () => {
    mockTokenEndpoint([{ body: { token_type: "Bearer", expires_in: 3600 } }]);

    await expect(getOAuthAccessToken("cred-1")).rejects.toThrow(/access_token/);
  });

  it("throws when credential is missing", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce(null);

    await expect(getOAuthAccessToken("missing-cred")).rejects.toThrow(/not found or disabled/);
  });

  it("throws on payload that doesn't match the oauth_client schema", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      id: "cred-bad",
      provider: "test",
      restUrl: null,
      fields: { clientId: "x" /* missing clientSecret and tokenUrl */ },
    });

    await expect(getOAuthAccessToken("cred-bad")).rejects.toThrow(/invalid payload/);
  });

  it("network error is wrapped with the token URL for context", async () => {
    mockTokenEndpoint([{ throws: new Error("ECONNREFUSED") }]);

    await expect(getOAuthAccessToken("cred-1")).rejects.toThrow(/unreachable.*ECONNREFUSED/);
  });

  it("in-flight Promise is cleaned up on rejection so the next call retries", async () => {
    mockTokenEndpoint([
      { ok: false, status: 500 },
      { body: { access_token: "tok-recovery", expires_in: 3600 } },
    ]);

    await expect(getOAuthAccessToken("cred-1")).rejects.toThrow(/500/);
    const t = await getOAuthAccessToken("cred-1");
    expect(t).toBe("tok-recovery");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });
});

describe("getOAuthAccessToken — token endpoint request shape", () => {
  it("sends grant_type=client_credentials with Basic auth header", async () => {
    mockTokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }]);

    await getOAuthAccessToken("cred-1");

    expect(fetchMock()).toHaveBeenCalledWith(
      "https://idp.example/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=client_credentials",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
        }),
      }),
    );
  });

  it("includes scope in the body when present on the credential", async () => {
    getCredentialFieldsByIdMock.mockResolvedValueOnce({
      ...VALID_CRED,
      fields: { ...VALID_CRED.fields, scope: "read:agents write:agents" },
    });
    mockTokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }]);

    await getOAuthAccessToken("cred-1");

    const [, init] = fetchMock().mock.calls[0];
    expect((init as RequestInit).body).toContain("scope=read");
  });

  it("falls back to default expiry when expires_in is missing", async () => {
    mockTokenEndpoint([{ body: { access_token: "tok-1" } }]);

    const t = await getOAuthAccessToken("cred-1");
    expect(t).toBe("tok-1");
    expect(_oauthTokenCacheSize()).toBe(1);
  });
});

describe("convenience helpers", () => {
  it("getOAuthAuthorizationHeader returns 'Bearer <token>'", async () => {
    mockTokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }]);

    const h = await getOAuthAuthorizationHeader("cred-1");
    expect(h).toBe("Bearer tok-1");
  });

  it("withOAuth merges Authorization into RequestInit headers", async () => {
    mockTokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }]);

    const init = await withOAuth("cred-1", {
      method: "POST",
      headers: { "X-Request-Id": "abc" },
    });

    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "X-Request-Id": "abc",
      Authorization: "Bearer tok-1",
    });
  });

  it("withOAuth overwrites a pre-existing Authorization header", async () => {
    mockTokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }]);

    const init = await withOAuth("cred-1", {
      headers: { Authorization: "Bearer stale-token" },
    });

    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });
});

describe("invalidation", () => {
  it("invalidateOAuthToken drops the cached entry so the next call re-fetches", async () => {
    mockTokenEndpoint([
      { body: { access_token: "tok-1", expires_in: 3600 } },
      { body: { access_token: "tok-2", expires_in: 3600 } },
    ]);

    expect(await getOAuthAccessToken("cred-1")).toBe("tok-1");
    invalidateOAuthToken("cred-1");
    expect(await getOAuthAccessToken("cred-1")).toBe("tok-2");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("credential cache invalidation clears all OAuth tokens", async () => {
    mockTokenEndpoint([
      { body: { access_token: "tok-A1", expires_in: 3600 } },
      { body: { access_token: "tok-B1", expires_in: 3600 } },
      { body: { access_token: "tok-A2", expires_in: 3600 } },
    ]);

    getCredentialFieldsByIdMock.mockImplementation(async (id: string) => ({
      id,
      provider: "test",
      restUrl: null,
      fields: {
        clientId: `client-${id}`,
        clientSecret: `secret-${id}`,
        tokenUrl: "https://idp.example/oauth/token",
      },
    }));

    await getOAuthAccessToken("cred-A");
    await getOAuthAccessToken("cred-B");
    expect(_oauthTokenCacheSize()).toBe(2);

    // Fire all registered subscribers — simulates
    // invalidateCredentialCache() being called.
    for (const cb of subscribers) cb();

    expect(_oauthTokenCacheSize()).toBe(0);

    // Next call re-fetches.
    const t = await getOAuthAccessToken("cred-A");
    expect(t).toBe("tok-A2");
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });
});
