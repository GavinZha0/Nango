import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Module-under-test deps. The credential lookup and the provider
// registry are both imported eagerly inside entity-catalog.ts, so
// we have to mock them at the module-graph level.
const getCredentialConfigById = vi.fn();
vi.mock("@/lib/credentials/lookup", () => ({
  getCredentialConfigById: (id: string) => getCredentialConfigById(id),
}));

const fetchEntitiesMock = vi.fn();
vi.mock("@/lib/backends/registry.server", () => ({
  BACKENDS: {
    agno: {
      controlPlane: {
        fetchEntities: (
          credId: string,
          baseUrl: string,
          token: string,
        ) => fetchEntitiesMock(credId, baseUrl, token),
      },
    },
  },
}));

vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { EntityCatalog } from "@/lib/backends/entity-catalog";
import type { EntityDescriptor } from "@/lib/backends/types";

function makeEntity(
  id: string,
  credentialId: string,
): EntityDescriptor {
  return { id, kind: "agent", provider: "agno", credentialId };
}

const CRED_ID = "11111111-1111-1111-1111-111111111111";
const CRED = {
  id: CRED_ID,
  enabled: true,
  provider: "agno" as const,
  restUrl: "https://agno.example",
  token: "tok",
  aguiUrl: null,
};

describe("EntityCatalog.list — singleflight", () => {
  beforeEach(() => {
    EntityCatalog.invalidate();
    getCredentialConfigById.mockReset();
    fetchEntitiesMock.mockReset();
  });

  afterEach(() => {
    EntityCatalog.invalidate();
  });

  it("dedupes N concurrent misses into one upstream fetch", async () => {
    getCredentialConfigById.mockResolvedValue(CRED);
    fetchEntitiesMock.mockResolvedValueOnce([makeEntity("a", CRED_ID)]);

    const results = await Promise.all([
      EntityCatalog.list(CRED_ID),
      EntityCatalog.list(CRED_ID),
      EntityCatalog.list(CRED_ID),
      EntityCatalog.list(CRED_ID),
      EntityCatalog.list(CRED_ID),
    ]);

    expect(fetchEntitiesMock).toHaveBeenCalledTimes(1);
    // All callers see the same result
    for (const r of results) {
      expect(r).toEqual([makeEntity("a", CRED_ID)]);
    }
  });

  it("the second call after the first resolved hits the cache (no new fetch)", async () => {
    getCredentialConfigById.mockResolvedValue(CRED);
    fetchEntitiesMock.mockResolvedValueOnce([makeEntity("a", CRED_ID)]);

    await EntityCatalog.list(CRED_ID);
    await EntityCatalog.list(CRED_ID);

    expect(fetchEntitiesMock).toHaveBeenCalledTimes(1);
  });

  it("when load throws, every concurrent caller sees the same error and the next call retries", async () => {
    getCredentialConfigById.mockResolvedValue(CRED);
    fetchEntitiesMock.mockRejectedValueOnce(new Error("upstream 500"));

    const settled = await Promise.allSettled([
      EntityCatalog.list(CRED_ID),
      EntityCatalog.list(CRED_ID),
      EntityCatalog.list(CRED_ID),
    ]);
    for (const s of settled) {
      expect(s.status).toBe("rejected");
      if (s.status === "rejected") {
        expect((s.reason as Error).message).toBe("upstream 500");
      }
    }
    expect(fetchEntitiesMock).toHaveBeenCalledTimes(1);

    // The failed in-flight must be cleared so a follow-up call retries.
    fetchEntitiesMock.mockResolvedValueOnce([makeEntity("b", CRED_ID)]);
    const next = await EntityCatalog.list(CRED_ID);
    expect(next).toEqual([makeEntity("b", CRED_ID)]);
    expect(fetchEntitiesMock).toHaveBeenCalledTimes(2);
  });

  it("invalidate(credId) during an in-flight load lets the first caller finish; second caller triggers a fresh fetch", async () => {
    getCredentialConfigById.mockResolvedValue(CRED);

    // Pre-create the hanging Promise so `releaseFetch` is bound
    // before fetchEntitiesMock is ever consulted.
    let releaseFetch: (rows: EntityDescriptor[]) => void = () => {};
    const hangingFetch = new Promise<EntityDescriptor[]>((resolve) => {
      releaseFetch = resolve;
    });
    fetchEntitiesMock.mockReturnValueOnce(hangingFetch);

    const p1 = EntityCatalog.list(CRED_ID);
    // Simulate a credential edit racing with the in-flight load.
    // lru-cache splits the singleflight: p1 keeps waiting on the
    // original fetch (ignoreFetchAbort), but the key is removed from
    // the cache so p2 starts a fresh fetch — which would pick up
    // the new credential. This is MORE correct than the old behavior
    // where both callers shared a fetch that started before the edit.
    EntityCatalog.invalidate(CRED_ID);

    fetchEntitiesMock.mockResolvedValueOnce([makeEntity("d", CRED_ID)]);
    const p2 = EntityCatalog.list(CRED_ID);

    releaseFetch([makeEntity("c", CRED_ID)]);
    const [r1, r2] = await Promise.all([p1, p2]);

    // p1 gets the result from the original in-flight fetch.
    expect(r1).toEqual([makeEntity("c", CRED_ID)]);
    // p2 gets fresh data from the post-invalidation fetch.
    expect(r2).toEqual([makeEntity("d", CRED_ID)]);
    // Two fetches: original + post-invalidation retry.
    expect(fetchEntitiesMock).toHaveBeenCalledTimes(2);
  });

  it("returns null without calling fetchEntities when credential is missing or disabled", async () => {
    getCredentialConfigById.mockResolvedValueOnce(null);

    const result = await EntityCatalog.list(CRED_ID);

    expect(result).toBeNull();
    expect(fetchEntitiesMock).not.toHaveBeenCalled();
  });

  it("returns [] when credential provider is not registered", async () => {
    getCredentialConfigById.mockResolvedValueOnce({
      ...CRED,
      provider: "unknown_platform",
    });

    const result = await EntityCatalog.list(CRED_ID);

    expect(result).toEqual([]);
    expect(fetchEntitiesMock).not.toHaveBeenCalled();
  });

  it("returns [] when credential is missing restUrl or token", async () => {
    getCredentialConfigById.mockResolvedValueOnce({
      ...CRED,
      restUrl: null,
      token: null,
    });

    const result = await EntityCatalog.list(CRED_ID);

    expect(result).toEqual([]);
    expect(fetchEntitiesMock).not.toHaveBeenCalled();
  });

  it("invalidate() without argument clears the entire cache", async () => {
    getCredentialConfigById.mockResolvedValue(CRED);
    fetchEntitiesMock.mockResolvedValueOnce([makeEntity("a", CRED_ID)]);
    fetchEntitiesMock.mockResolvedValueOnce([makeEntity("b", CRED_ID)]);

    await EntityCatalog.list(CRED_ID);
    EntityCatalog.invalidate(); // no arg = clear all
    const result = await EntityCatalog.list(CRED_ID);

    // Second fetch proves cache was cleared.
    expect(fetchEntitiesMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([makeEntity("b", CRED_ID)]);
  });

  it("_cacheSize() reports current entry count", async () => {
    getCredentialConfigById.mockResolvedValue(CRED);
    fetchEntitiesMock.mockResolvedValueOnce([makeEntity("a", CRED_ID)]);

    expect(EntityCatalog._cacheSize()).toBe(0);
    await EntityCatalog.list(CRED_ID);
    expect(EntityCatalog._cacheSize()).toBe(1);
    EntityCatalog.invalidate(CRED_ID);
    expect(EntityCatalog._cacheSize()).toBe(0);
  });
});
