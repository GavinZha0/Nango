import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let mockCacheRoot = "";
vi.mock("@/lib/config", () => ({
  getConfig: (key: string, defaultValue: string) => {
    if (key === "datasource.cache_root") return mockCacheRoot;
    return defaultValue;
  },
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigBoolean: (_key: string, defaultValue: boolean) => defaultValue,
}));

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  InvalidCacheKeyError,
  abortWriteSlot,
  acquireWriteSlot,
  commitWriteSlot,
  datasetDir,
  getCacheStatus,
  hashQuery,
  invalidateDataset,
  purgeAllDatasets,
  validateDatasetName,
} from "@/lib/data-sources/cache";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nango-cache-test-"));
  mockCacheRoot = tmpRoot;
});

afterEach(async () => {
  mockCacheRoot = "";
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("validateDatasetName", () => {
  it.each([
    "sales",
    "sales_q1_2025",
    "a-b-c",
    "x".repeat(128),
  ])("accepts %s", (n) => {
    expect(() => validateDatasetName(n)).not.toThrow();
  });

  it.each([
    "",
    "../etc/passwd",
    "Sales",          // uppercase
    "9-leading-digit-ok-actually",  // this is OK
    "/abs/path",
    "x".repeat(129),
    "with spaces",
  ])("rejects %s", (n) => {
    if (n === "9-leading-digit-ok-actually") {
      expect(() => validateDatasetName(n)).not.toThrow();
    } else {
      expect(() => validateDatasetName(n)).toThrow(InvalidCacheKeyError);
    }
  });
});

describe("hashQuery", () => {
  it("produces stable hashes", () => {
    expect(hashQuery("SELECT * FROM users")).toBe(hashQuery("SELECT * FROM users"));
  });

  it("normalises whitespace but preserves case + comments", () => {
    expect(hashQuery("SELECT  *   FROM users")).toBe(hashQuery("SELECT * FROM users"));
    expect(hashQuery("SELECT * FROM USERS")).not.toBe(hashQuery("SELECT * FROM users"));
    expect(hashQuery("-- c\nSELECT * FROM users")).not.toBe(hashQuery("SELECT * FROM users"));
  });

  it("starts with sha256: prefix", () => {
    expect(hashQuery("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("acquireWriteSlot / commitWriteSlot", () => {
  it("returns a fresh tmp dir under cache root", async () => {
    const slot = await acquireWriteSlot("sales");
    expect(slot.tmpDir.startsWith(tmpRoot)).toBe(true);
    expect(slot.outputPath.endsWith("/part-001.parquet")).toBe(true);
    const stat = await fs.stat(slot.tmpDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("commit promotes tmp to final dir + writes meta", async () => {
    const slot = await acquireWriteSlot("sales");
    await fs.writeFile(slot.outputPath, "fake-parquet");

    const meta = await commitWriteSlot({
      name: "sales",
      slot,
      source: "postgres",
      dataSourceId: "cred-1",
      queryHash: hashQuery("SELECT 1"),
      ttlHours: 24,
      rowCount: 42,
      byteSize: 12,
    });

    expect(meta.name).toBe("sales");
    expect(meta.source).toBe("postgres");
    expect(meta.rowCount).toBe(42);

    const final = datasetDir("sales");
    const finalContent = await fs.readFile(path.join(final, "part-001.parquet"), "utf-8");
    expect(finalContent).toBe("fake-parquet");
    // tmp is gone
    await expect(fs.stat(slot.tmpDir)).rejects.toThrow();
  });

  it("commit replaces an existing dataset (TTL refresh)", async () => {
    // First write
    const slot1 = await acquireWriteSlot("sales");
    await fs.writeFile(slot1.outputPath, "v1");
    await commitWriteSlot({
      name: "sales",
      slot: slot1,
      source: "postgres",
      dataSourceId: null,
      queryHash: "h1",
      ttlHours: 1,
      rowCount: 1,
      byteSize: 2,
    });
    // Second write replaces
    const slot2 = await acquireWriteSlot("sales");
    await fs.writeFile(slot2.outputPath, "v2");
    await commitWriteSlot({
      name: "sales",
      slot: slot2,
      source: "postgres",
      dataSourceId: null,
      queryHash: "h2",
      ttlHours: 1,
      rowCount: 1,
      byteSize: 2,
    });
    const content = await fs.readFile(
      path.join(datasetDir("sales"), "part-001.parquet"),
      "utf-8",
    );
    expect(content).toBe("v2");
  });
});

describe("abortWriteSlot", () => {
  it("removes the tmp dir and is idempotent on missing dir", async () => {
    const slot = await acquireWriteSlot("sales");
    await abortWriteSlot(slot);
    await expect(fs.stat(slot.tmpDir)).rejects.toThrow();
    // calling again on already-deleted slot does not throw
    await abortWriteSlot(slot);
  });
});

describe("getCacheStatus", () => {
  it("returns missing for a name with no meta", async () => {
    const s = await getCacheStatus("nope");
    expect(s.exists).toBe(false);
    expect(s.meta).toBeNull();
    expect(s.isFresh).toBe(false);
  });

  it("returns fresh for a recent dataset", async () => {
    const slot = await acquireWriteSlot("sales");
    await fs.writeFile(slot.outputPath, "x");
    await commitWriteSlot({
      name: "sales",
      slot,
      source: "postgres",
      dataSourceId: null,
      queryHash: "h",
      ttlHours: 24,
      rowCount: 1,
      byteSize: 1,
    });
    const s = await getCacheStatus("sales");
    expect(s.exists).toBe(true);
    expect(s.isFresh).toBe(true);
    expect(s.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("returns stale when ttl elapsed", async () => {
    const slot = await acquireWriteSlot("sales");
    await fs.writeFile(slot.outputPath, "x");
    await commitWriteSlot({
      name: "sales",
      slot,
      source: "postgres",
      dataSourceId: null,
      queryHash: "h",
      ttlHours: 1,
      rowCount: 1,
      byteSize: 1,
    });
    // hand-edit the meta to force expiry
    const metaFile = path.join(tmpRoot, "parquet", "sales.meta.json");
    const meta = JSON.parse(await fs.readFile(metaFile, "utf-8"));
    meta.createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await fs.writeFile(metaFile, JSON.stringify(meta));

    const s = await getCacheStatus("sales");
    expect(s.exists).toBe(true);
    expect(s.isFresh).toBe(false);
  });
});

describe("invalidateDataset", () => {
  it("removes dir + meta; idempotent", async () => {
    const slot = await acquireWriteSlot("sales");
    await fs.writeFile(slot.outputPath, "x");
    await commitWriteSlot({
      name: "sales",
      slot,
      source: "postgres",
      dataSourceId: null,
      queryHash: "h",
      ttlHours: 1,
      rowCount: 1,
      byteSize: 1,
    });
    await invalidateDataset("sales");
    expect((await getCacheStatus("sales")).exists).toBe(false);
    // second call fine
    await invalidateDataset("sales");
  });
});

describe("purgeAllDatasets", () => {
  async function seed(name: string): Promise<void> {
    const slot = await acquireWriteSlot(name);
    await fs.writeFile(slot.outputPath, "x");
    await commitWriteSlot({
      name,
      slot,
      source: "postgres",
      dataSourceId: null,
      queryHash: "h",
      ttlHours: 1,
      rowCount: 1,
      byteSize: 1,
    });
  }

  it("returns 0 when the parquet root does not exist (cold first boot)", async () => {
    expect(await purgeAllDatasets()).toBe(0);
  });

  it("removes every dataset + sidecar and reports the count", async () => {
    await seed("a");
    await seed("b");
    await seed("c");
    expect((await getCacheStatus("a")).exists).toBe(true);

    const removed = await purgeAllDatasets();
    // Each seeded dataset contributes a directory + a .meta.json
    // sibling, so 3 datasets → 6 top-level entries.
    expect(removed).toBe(6);

    expect((await getCacheStatus("a")).exists).toBe(false);
    expect((await getCacheStatus("b")).exists).toBe(false);
    expect((await getCacheStatus("c")).exists).toBe(false);
  });

  it("is idempotent: a second call after a full purge returns 0", async () => {
    await seed("solo");
    await purgeAllDatasets();
    expect(await purgeAllDatasets()).toBe(0);
  });

  it("clears in-flight write slots that didn't commit (.tmp-* dirs)", async () => {
    // Acquire but never commit. The .tmp-<name>-<uuid> dir lingers
    // alongside committed datasets and must also be swept on boot
    // — without this the next process can't grow the cache without
    // first stepping on yesterday's orphan write dirs.
    const slot = await acquireWriteSlot("crashed");
    await fs.writeFile(slot.outputPath, "x");

    const removed = await purgeAllDatasets();
    expect(removed).toBeGreaterThan(0);

    const parquetRoot = path.join(tmpRoot, "parquet");
    const after = await fs
      .readdir(parquetRoot)
      .catch(() => [] as string[]);
    expect(after).toEqual([]);
  });
});
