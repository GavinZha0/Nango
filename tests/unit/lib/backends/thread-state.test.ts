import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Chained select / insert builders are stubbed per-test via setSelectRows /
// setInsertImpl so we can assert the DB is consulted on cache miss but
// NOT on cache hit (the hot-path optimisation under test).
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
};
const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn(),
};
const dbMock = {
  select: vi.fn(() => selectChain),
  insert: vi.fn(() => insertChain),
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

vi.mock("@/lib/db/schema", () => ({
  BackendThreadStateTable: {
    credentialId: "credential_id",
    threadId: "thread_id",
    state: "state",
    updatedAt: "updated_at",
  },
}));

function setSelectRows(rows: unknown[]): void {
  selectChain.limit.mockResolvedValueOnce(rows);
}

function setSelectError(err: Error): void {
  selectChain.limit.mockRejectedValueOnce(err);
}

function setInsertOk(): void {
  insertChain.onConflictDoUpdate.mockResolvedValueOnce(undefined);
}

function setInsertError(err: Error): void {
  insertChain.onConflictDoUpdate.mockRejectedValueOnce(err);
}

const {
  getThreadProviderState,
  setThreadProviderState,
  __resetThreadStateCacheForTests,
} = await import("@/lib/backends/thread-state.server");

interface DifyState {
  convId: string;
}

const CRED = "00000000-0000-0000-0000-000000000001";
const THREAD = "thread-abc";

beforeEach(() => {
  vi.clearAllMocks();
  __resetThreadStateCacheForTests();
});

describe("getThreadProviderState", () => {
  it("returns undefined and consults DB on cold cache when no row exists", async () => {
    setSelectRows([]);

    const result = await getThreadProviderState<DifyState>(CRED, THREAD, "dify");

    expect(result).toBeUndefined();
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it("returns persisted provider state on first call, then serves cache without DB", async () => {
    setSelectRows([{ state: { dify: { convId: "conv-xyz" } } }]);

    const first = await getThreadProviderState<DifyState>(CRED, THREAD, "dify");
    const second = await getThreadProviderState<DifyState>(CRED, THREAD, "dify");

    expect(first).toEqual({ convId: "conv-xyz" });
    expect(second).toEqual({ convId: "conv-xyz" });
    // Cache hit on second call: no second SELECT.
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on DB error and warns rather than throwing", async () => {
    setSelectError(new Error("connection refused"));

    const result = await getThreadProviderState<DifyState>(CRED, THREAD, "dify");

    expect(result).toBeUndefined();
  });

  it("returns undefined when row exists but provider key is missing", async () => {
    setSelectRows([{ state: { mastra: { foo: "bar" } } }]);

    const result = await getThreadProviderState<DifyState>(CRED, THREAD, "dify");

    expect(result).toBeUndefined();
  });
});

describe("setThreadProviderState", () => {
  it("populates cache synchronously even before DB completes", async () => {
    setInsertOk();

    await setThreadProviderState(CRED, THREAD, "dify", { convId: "conv-1" });

    // Subsequent read hits cache (no DB).
    const cached = await getThreadProviderState<DifyState>(CRED, THREAD, "dify");
    expect(cached).toEqual({ convId: "conv-1" });
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("merges patches into existing provider state instead of overwriting siblings", async () => {
    // Seed: existing row has state.dify.convId.
    setSelectRows([{ state: { dify: { convId: "old-conv" }, mastra: { token: "m1" } } }]);
    await getThreadProviderState<DifyState>(CRED, THREAD, "dify");

    setInsertOk();
    await setThreadProviderState(CRED, THREAD, "dify", { convId: "new-conv" });

    // mastra sibling preserved; dify.convId updated.
    const insertCall = insertChain.values.mock.calls[0][0] as {
      state: { dify: { convId: string }; mastra: { token: string } };
    };
    expect(insertCall.state.dify.convId).toBe("new-conv");
    expect(insertCall.state.mastra).toEqual({ token: "m1" });
  });

  it("does not throw on DB persist error; cache still updated", async () => {
    setInsertError(new Error("disk full"));

    await expect(
      setThreadProviderState(CRED, THREAD, "dify", { convId: "conv-2" }),
    ).resolves.toBeUndefined();

    // Cache retained for current process even though DB failed.
    const cached = await getThreadProviderState<DifyState>(CRED, THREAD, "dify");
    expect(cached).toEqual({ convId: "conv-2" });
  });
});

describe("LRU eviction behavior", () => {
  it("evicts least-recently-used entries, not earliest-inserted (FIFO bug regression)", async () => {
    // Fill cache with entries. The production max is 5000 but we can
    // still verify LRU semantics: insert A, then B..N, access A again,
    // then keep inserting until one of A/B must be evicted. LRU should
    // evict B (oldest-accessed), not A (oldest-inserted but recently-accessed).
    //
    // Since we can't change max at test time, we rely on the module's
    // max of 5000 and insert up to the limit.
    const { _cacheSize } = await import("@/lib/backends/thread-state.server");

    // Insert entry "old" (will be accessed later to keep it alive).
    setInsertOk();
    await setThreadProviderState(CRED, "old-thread", "dify", { convId: "old" });

    // Insert 4999 more entries to fill up to max.
    for (let i = 0; i < 4999; i++) {
      setInsertOk();
      await setThreadProviderState(CRED, `fill-${i}`, "dify", { convId: `f${i}` });
    }
    expect(_cacheSize()).toBe(5000);

    // Access "old-thread" to promote it to most-recently-used.
    const old = await getThreadProviderState<DifyState>(CRED, "old-thread", "dify");
    expect(old).toEqual({ convId: "old" });

    // Insert one more entry — this should evict the LRU entry (fill-0,
    // the earliest-inserted that was never re-accessed), NOT "old-thread"
    // which was just accessed.
    setInsertOk();
    await setThreadProviderState(CRED, "new-thread", "dify", { convId: "new" });
    expect(_cacheSize()).toBe(5000); // still at max

    // "old-thread" survives (recently accessed despite being earliest-inserted).
    const stillAlive = await getThreadProviderState<DifyState>(CRED, "old-thread", "dify");
    expect(stillAlive).toEqual({ convId: "old" });
    // No DB select needed — cache hit.
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe("isolation between (cred, thread) pairs", () => {
  it("does not leak state across distinct threads on the same credential", async () => {
    setInsertOk();
    setInsertOk();

    await setThreadProviderState(CRED, "thread-a", "dify", { convId: "A" });
    await setThreadProviderState(CRED, "thread-b", "dify", { convId: "B" });

    const a = await getThreadProviderState<DifyState>(CRED, "thread-a", "dify");
    const b = await getThreadProviderState<DifyState>(CRED, "thread-b", "dify");

    expect(a).toEqual({ convId: "A" });
    expect(b).toEqual({ convId: "B" });
  });
});
