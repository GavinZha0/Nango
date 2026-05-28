import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock DB and schema
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  SkillTable: {
    id: "id",
    name: "name",
    description: "description",
    skillMd: "skill_md",
    source: "source",
    enabled: "enabled",
    visibility: "visibility",
    createdBy: "created_by",
  },
}));

// Mock the SKILL.md parser
vi.mock("@/lib/skills/parser", () => ({
  parseSkillMd: vi.fn((md: string) => ({
    name: "test-skill",
    description: "A test skill",
    body: md,
    frontmatter: {},
  })),
}));

import { SkillPool, type SkillSpecLoader } from "@/lib/skills/skill-pool";
import type { SkillSpec } from "@/lib/skills/skill-pool";
import type { ParsedSkillMd } from "@/lib/skills/parser";

function fakeSpec(id: string): SkillSpec {
  return {
    skillId: id,
    name: `skill-${id}`,
    description: "A test skill",
    skillMd: "---\nname: test\n---\nbody",
    parsed: { frontmatter: { name: "test", description: "A test skill", version: "1.0.0", extras: {} }, body: "body" } as ParsedSkillMd,
    source: "local",
    enabled: true,
    visibility: "public",
    createdBy: "user-1",
  };
}

describe("SkillPool", () => {
  let loader: SkillSpecLoader;
  let pool: SkillPool;

  beforeEach(() => {
    loader = vi.fn();
    pool = new SkillPool({ load: loader, max: 5, ttl: 60_000 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Cache semantics ---

  it("returns null when loader returns null (missing / disabled)", async () => {
    vi.mocked(loader).mockResolvedValueOnce(null);

    const result = await pool.get("nonexistent");

    expect(result).toBeNull();
    expect(loader).toHaveBeenCalledWith("nonexistent");
  });

  it("returns the spec on cache miss, then cache hit on second call", async () => {
    const spec = fakeSpec("s1");
    vi.mocked(loader).mockResolvedValueOnce(spec);

    const r1 = await pool.get("s1");
    const r2 = await pool.get("s1");

    expect(r1).toEqual(spec);
    expect(r2).toEqual(spec);
    // Loader called only once — second call was a cache hit.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not cache null results — re-invokes loader on next call", async () => {
    vi.mocked(loader).mockResolvedValueOnce(null);
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s1"));

    const r1 = await pool.get("s1");
    const r2 = await pool.get("s1");

    expect(r1).toBeNull();
    expect(r2).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  // --- Concurrent dedup ---

  it("deduplicates concurrent fetches for the same key", async () => {
    const spec = fakeSpec("s1");
    vi.mocked(loader).mockResolvedValueOnce(spec);

    const results = await Promise.all([
      pool.get("s1"),
      pool.get("s1"),
      pool.get("s1"),
    ]);

    for (const r of results) {
      expect(r).toEqual(spec);
    }
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // --- Invalidation ---

  it("invalidate(id) drops a single entry, forcing reload", async () => {
    const v1 = fakeSpec("s1");
    const v2 = { ...fakeSpec("s1"), description: "updated" };
    vi.mocked(loader).mockResolvedValueOnce(v1);
    vi.mocked(loader).mockResolvedValueOnce(v2);

    await pool.get("s1");
    pool.invalidate("s1");
    const result = await pool.get("s1");

    expect(result!.description).toBe("updated");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidate(id) does not affect other entries", async () => {
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s1"));
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s2"));

    await pool.get("s1");
    await pool.get("s2");
    pool.invalidate("s1");

    // s2 still cached — no reload needed.
    const r = await pool.get("s2");
    expect(r).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidateAll() clears every entry", async () => {
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s1"));
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s2"));
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s1"));
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s2"));

    await pool.get("s1");
    await pool.get("s2");
    pool.invalidateAll();

    await pool.get("s1");
    await pool.get("s2");
    // 2 initial loads + 2 reloads after clear.
    expect(loader).toHaveBeenCalledTimes(4);
  });

  // --- getMany ---

  it("getMany returns specs in order, dropping nulls", async () => {
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s1"));
    vi.mocked(loader).mockResolvedValueOnce(null);
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s3"));

    const results = await pool.getMany(["s1", "s2", "s3"]);

    expect(results.map((s) => s.skillId)).toEqual(["s1", "s3"]);
  });

  // --- Test helpers ---

  it("_size() reports current cache size", async () => {
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s1"));
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s2"));

    expect(pool._size()).toBe(0);
    await pool.get("s1");
    expect(pool._size()).toBe(1);
    await pool.get("s2");
    expect(pool._size()).toBe(2);
    pool.invalidate("s1");
    expect(pool._size()).toBe(1);
  });

  it("_has() checks entry existence", async () => {
    vi.mocked(loader).mockResolvedValueOnce(fakeSpec("s1"));

    expect(pool._has("s1")).toBe(false);
    await pool.get("s1");
    expect(pool._has("s1")).toBe(true);
    pool.invalidate("s1");
    expect(pool._has("s1")).toBe(false);
  });
});
