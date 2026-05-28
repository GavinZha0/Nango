import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// We mock the upstream provider factory so the pool never opens a real
// MCP connection during tests. Each call to `createGracefulMcpProvider`
// is a separate fake provider with its own `close()` spy, letting us
// assert refcount-driven close semantics precisely.
vi.mock("@/lib/mcp/client-providers", () => ({
  createGracefulMcpProvider: vi.fn(),
}));

const { McpProviderPool } = await import("@/lib/mcp/provider-pool");
import type {
  McpServerConfig,
  McpServerConfigLoader,
} from "@/lib/mcp/provider-pool";
import type { GracefulMcpProvider } from "@/lib/mcp/client-providers";

type CloseMock = ReturnType<typeof vi.fn<() => Promise<void>>>;

interface FakeProvider extends Omit<GracefulMcpProvider, "close"> {
  close: CloseMock;
  /** Unique id, lets us assert "same provider object" reuse semantics. */
  __id: number;
}

let nextProviderId: number = 0;

/** Build a fresh fake provider; caller controls its identity for assertions. */
function makeProvider(): FakeProvider {
  const id: number = ++nextProviderId;
  const close: CloseMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return {
    async tools() {
      return {} as never;
    },
    close,
    __id: id,
    // Health surface added for dispatch-layer degradation reporting;
    // pool-only tests don't exercise the unhappy paths, so a static
    // `"ready"` is fine. Provider-level health is exercised in
    // tool-failure.test.ts.
    label: `fake-mcp-${id}`,
    health: "ready",
    lastErrorMessage: null,
  };
}

/** Build a config loader that resolves known ids and rejects the rest. */
function makeLoader(known: Record<string, McpServerConfig>): McpServerConfigLoader {
  return async (serverId: string) => known[serverId] ?? null;
}

const cfg = (id: string): McpServerConfig => ({
  serverId: id,
  label: `mcp-${id}`,
  type: "http",
  url: `http://localhost/${id}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  nextProviderId = 0;
});

describe("McpProviderPool: borrow / release", () => {
  it("creates a provider on first borrow and reuses it on the second", async () => {
    const factory = vi.fn(() => makeProvider());
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: factory,
    });

    const p1 = await pool.borrow("s1");
    const p2 = await pool.borrow("s1");

    expect(p1).toBe(p2);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(pool._inspect().entries).toEqual([
      { serverId: "s1", refs: 2, idleSince: null },
    ]);
  });

  it("decrements refs on release; sets idleSince once refs=0", async () => {
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: () => makeProvider(),
    });

    const p = await pool.borrow("s1");
    await pool.borrow("s1");

    pool.release("s1", p);
    expect(pool._inspect().entries[0].refs).toBe(1);
    expect(pool._inspect().entries[0].idleSince).toBeNull();

    pool.release("s1", p);
    const snap = pool._inspect().entries[0];
    expect(snap.refs).toBe(0);
    expect(snap.idleSince).not.toBeNull();
  });

  it("ignores releases that would drive refs below zero", async () => {
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: () => makeProvider(),
    });

    const p = await pool.borrow("s1");
    pool.release("s1", p);
    pool.release("s1", p); // stray
    pool.release("s1", p); // stray

    const snap = pool._inspect().entries[0];
    expect(snap.refs).toBe(0);
  });

  it("ignores release of an unknown serverId without throwing", () => {
    const pool = new McpProviderPool({
      loadConfig: makeLoader({}),
      createProvider: () => makeProvider(),
    });

    expect(() => pool.release("never-borrowed", makeProvider())).not.toThrow();
  });

  it("throws when the loader returns null for the requested server", async () => {
    const pool = new McpProviderPool({
      loadConfig: makeLoader({}),
      createProvider: () => makeProvider(),
    });

    await expect(pool.borrow("missing")).rejects.toThrow(/not found or disabled/);
    // Failed creates must not leave a creating-slot behind, so a retry
    // genuinely re-enters the loader.
    expect(pool._inspect().creating).toEqual([]);
  });
});

describe("McpProviderPool: concurrent borrow de-duplication", () => {
  it("opens only one connection when N borrows race the first connect", async () => {
    const factory = vi.fn(() => makeProvider());
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: factory,
    });

    const [p1, p2, p3] = await Promise.all([
      pool.borrow("s1"),
      pool.borrow("s1"),
      pool.borrow("s1"),
    ]);

    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(pool._inspect().entries).toEqual([
      { serverId: "s1", refs: 3, idleSince: null },
    ]);
    expect(pool._inspect().creating).toEqual([]);
  });

  it("clears the creating slot when create rejects, allowing later retries", async () => {
    let attempt: number = 0;
    const loader: McpServerConfigLoader = async (id: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error("first attempt fails");
      return cfg(id);
    };
    const pool = new McpProviderPool({
      loadConfig: loader,
      createProvider: () => makeProvider(),
    });

    await expect(pool.borrow("s1")).rejects.toThrow(/first attempt fails/);
    expect(pool._inspect().creating).toEqual([]);

    // Retry must re-enter the loader, not return the failed result.
    const p = await pool.borrow("s1");
    expect(p).toBeDefined();
    expect(attempt).toBe(2);
  });
});

describe("McpProviderPool: reaper", () => {
  it("closes idle entries whose age exceeds idleTimeoutMs", async () => {
    let now: number = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const provider = makeProvider();
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: () => provider,
      idleTimeoutMs: 1_000,
    });

    const p = await pool.borrow("s1");
    pool.release("s1", p); // idleSince = 1_000_000

    // Just under the threshold — must NOT close.
    now = 1_000_999;
    pool._runReaperNow();
    expect(provider.close).not.toHaveBeenCalled();
    expect(pool._inspect().entries).toHaveLength(1);

    // Cross the threshold — closes and removes.
    now = 1_001_001;
    pool._runReaperNow();
    expect(provider.close).toHaveBeenCalledTimes(1);
    expect(pool._inspect().entries).toEqual([]);
  });

  it("does not close entries that are still in use", async () => {
    let now: number = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const provider = makeProvider();
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: () => provider,
      idleTimeoutMs: 1_000,
    });

    await pool.borrow("s1"); // refs=1, idleSince=null

    now = 1_999_999_999;
    pool._runReaperNow();

    expect(provider.close).not.toHaveBeenCalled();
    expect(pool._inspect().entries[0].refs).toBe(1);
  });
});

describe("McpProviderPool: evict", () => {
  it("closes immediately when no borrowers are active", async () => {
    const provider = makeProvider();
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: () => provider,
    });

    const p = await pool.borrow("s1");
    pool.release("s1", p);

    await pool.evict("s1");

    expect(provider.close).toHaveBeenCalledTimes(1);
    expect(pool._inspect().entries).toEqual([]);
    expect(pool._inspect().draining).toEqual([]);
  });

  it("detaches the entry while in use; future borrows open a fresh provider", async () => {
    const factory = vi.fn(() => makeProvider());
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: factory,
    });

    const p1 = (await pool.borrow("s1")) as FakeProvider;
    expect(p1.__id).toBe(1);

    // Evict while p1 is still borrowed: p1's connection must stay alive
    // for the in-flight caller, but the active map is cleared so the
    // next borrow opens a brand-new connection.
    await pool.evict("s1");
    expect(p1.close).not.toHaveBeenCalled();
    expect(pool._inspect().entries).toEqual([]);
    expect(pool._inspect().draining).toEqual([{ serverId: "s1", refs: 1 }]);

    const p2 = (await pool.borrow("s1")) as FakeProvider;
    expect(p2.__id).toBe(2); // different provider object
    expect(factory).toHaveBeenCalledTimes(2);

    // p1's caller finally releases — close fires for the old provider only.
    pool.release("s1", p1);
    expect(p1.close).toHaveBeenCalledTimes(1);
    expect(p2.close).not.toHaveBeenCalled();
    expect(pool._inspect().draining).toEqual([]);

    // p2's caller releases too: stays cached (idle), reaper would close later.
    pool.release("s1", p2);
    expect(p2.close).not.toHaveBeenCalled();
    expect(pool._inspect().entries[0].refs).toBe(0);
  });

  it("is a no-op when the serverId is not in the pool", async () => {
    const pool = new McpProviderPool({
      loadConfig: makeLoader({}),
      createProvider: () => makeProvider(),
    });

    await expect(pool.evict("ghost")).resolves.toBeUndefined();
  });
});

describe("McpProviderPool: failure cooldown", () => {
  it("evictWithCooldown rejects subsequent borrows until the window elapses", async () => {
    // Mock Date.now so we can advance time deterministically without
    // depending on the relationship between setTimeout firing and the
    // wall clock (vitest can desync these under certain conditions).
    let fakeNow = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    try {
      const factory = vi.fn(() => makeProvider());
      const cooldownMs = 30_000;
      const pool = new McpProviderPool({
        loadConfig: makeLoader({ s1: cfg("s1") }),
        createProvider: factory,
        failureCooldownMs: cooldownMs,
      });

      // First borrow + release → entry caches a provider.
      const p1 = (await pool.borrow("s1")) as FakeProvider;
      pool.release("s1", p1);
      expect(factory).toHaveBeenCalledTimes(1);

      // Simulate "provider reported unhealthy" path — caller evicts +
      // sets cooldown.
      await pool.evictWithCooldown("s1");

      // Inside the cooldown window: borrow must reject, factory must
      // NOT be called again (back-pressure).
      await expect(pool.borrow("s1")).rejects.toThrow(/cooldown/i);
      expect(factory).toHaveBeenCalledTimes(1);

      // Advance virtual time past the cooldown window.
      fakeNow += cooldownMs + 1;

      // Now a borrow should succeed and create a brand-new provider.
      const p2 = (await pool.borrow("s1")) as FakeProvider;
      expect(factory).toHaveBeenCalledTimes(2);
      expect(p2.__id).not.toBe(p1.__id);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("evict (without cooldown) does NOT block subsequent borrows", async () => {
    const factory = vi.fn(() => makeProvider());
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1") }),
      createProvider: factory,
      failureCooldownMs: 5_000, // long, so we'd notice if cooldown leaked
    });

    const p1 = (await pool.borrow("s1")) as FakeProvider;
    pool.release("s1", p1);

    await pool.evict("s1"); // no cooldown set

    // Immediate re-borrow opens a fresh provider — no rejection.
    const p2 = (await pool.borrow("s1")) as FakeProvider;
    expect(factory).toHaveBeenCalledTimes(2);
    expect(p2.__id).not.toBe(p1.__id);
  });
});

describe("McpProviderPool: shutdown", () => {
  it("closes active and draining providers and rejects new borrows", async () => {
    const active = makeProvider();
    const drained = makeProvider();
    let nextProvider: FakeProvider = active;
    const pool = new McpProviderPool({
      loadConfig: makeLoader({ s1: cfg("s1"), s2: cfg("s2") }),
      createProvider: () => nextProvider,
    });

    nextProvider = active;
    const a = await pool.borrow("s1");
    pool.release("s1", a);

    nextProvider = drained;
    await pool.borrow("s2"); // refs=1, never released
    await pool.evict("s2"); // → draining

    await pool.shutdown();

    expect(active.close).toHaveBeenCalledTimes(1);
    expect(drained.close).toHaveBeenCalledTimes(1);
    await expect(pool.borrow("s1")).rejects.toThrow(/shutting down/);
    expect(pool._inspect().entries).toEqual([]);
    expect(pool._inspect().draining).toEqual([]);
  });

  it("is idempotent", async () => {
    const pool = new McpProviderPool({
      loadConfig: makeLoader({}),
      createProvider: () => makeProvider(),
    });
    await pool.shutdown();
    await expect(pool.shutdown()).resolves.toBeUndefined();
  });
});
