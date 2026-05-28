import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock DB — config service uses db.select/insert/update/delete
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};
const insertChain = {
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([{ id: "new-uuid" }]),
};
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue(undefined),
};
const deleteChain = {
  where: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([{ id: "del-uuid" }]),
};

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
    delete: vi.fn(() => deleteChain),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  ConfigTable: {
    id: "id",
    key: "key",
    value: "value",
    valueType: "value_type",
    options: "options",
    prevValue: "prev_value",
    description: "description",
    updatedBy: "updated_by",
    updatedAt: "updated_at",
    createdAt: "created_at",
  },
}));

const {
  loadAllConfigs,
  invalidateConfigCache,
  getConfig,
  getConfigNumber,
  getConfigMs,
  getConfigBoolean,
  getConfigJson,
  deleteConfig,
  _isLoaded,
  _cacheSize,
  __resetConfigForTests,
} = await import("@/lib/config/service");

const { CONFIG_DEFAULTS } = await import("@/lib/config/defaults");

beforeEach(() => {
  vi.clearAllMocks();
  __resetConfigForTests();
});

// ── Read helpers (before loadAllConfigs — fallback to defaults) ──────

describe("getConfig — before load (code defaults only)", () => {
  it("returns code default for a predefined key", () => {
    const result = getConfig("sandbox.timeout", "99");
    expect(result).toBe("30"); // from CONFIG_DEFAULTS
  });

  it("returns the defaultValue param for an unknown key", () => {
    expect(getConfig("nonexistent.key", "fallback")).toBe("fallback");
  });
});

describe("getConfigNumber", () => {
  it("parses numeric string from defaults", () => {
    expect(getConfigNumber("cache.agent_pool.max", 999)).toBe(500);
  });

  it("returns defaultValue for unknown key", () => {
    expect(getConfigNumber("nope", 42)).toBe(42);
  });

  it("returns defaultValue for non-numeric string", async () => {
    // Load a cache with a non-numeric value
    selectChain.from.mockReturnValueOnce({
      ...selectChain,
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValueOnce([]),
    });
    vi.mocked((await import("@/lib/db")).db.select).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([{ key: "test.nan", value: "not-a-number" }]),
    } as never);
    await loadAllConfigs();

    expect(getConfigNumber("test.nan", 7)).toBe(7);
  });
});

describe("getConfigMs", () => {
  it("multiplies seconds by 1000", () => {
    // sandbox.timeout default = "30" seconds
    expect(getConfigMs("sandbox.timeout", 30)).toBe(30_000);
  });

  it("uses defaultSeconds param for unknown key", () => {
    expect(getConfigMs("nope", 5)).toBe(5_000);
  });
});

describe("getConfigBoolean", () => {
  it("returns defaultValue for unknown key", () => {
    expect(getConfigBoolean("nope", true)).toBe(true);
    expect(getConfigBoolean("nope", false)).toBe(false);
  });
});

describe("getConfigJson", () => {
  it("returns defaultValue for unknown key", () => {
    expect(getConfigJson("nope", [1, 2])).toEqual([1, 2]);
  });
});

// ── loadAllConfigs ──────────────────────────────────────────────────

describe("loadAllConfigs", () => {
  it("populates cache from DB rows", async () => {
    vi.mocked((await import("@/lib/db")).db.select).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([
        { key: "sandbox.timeout", value: "60" },
        { key: "sandbox.memory_mb", value: "512" },
      ]),
    } as never);

    await loadAllConfigs();

    expect(_isLoaded()).toBe(true);
    expect(_cacheSize()).toBe(2);
    // DB value overrides code default
    expect(getConfig("sandbox.timeout", "30")).toBe("60");
    expect(getConfigNumber("sandbox.memory_mb", 256)).toBe(512);
  });

  it("falls back to defaults on DB error", async () => {
    vi.mocked((await import("@/lib/db")).db.select).mockReturnValueOnce({
      from: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);

    await loadAllConfigs(); // should not throw

    expect(_isLoaded()).toBe(false);
    // Still works via code defaults
    expect(getConfig("sandbox.timeout", "30")).toBe("30");
  });
});

// ── invalidateConfigCache ───────────────────────────────────────────

describe("invalidateConfigCache", () => {
  it("clears cache and resets loaded flag", async () => {
    vi.mocked((await import("@/lib/db")).db.select).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([{ key: "k", value: "v" }]),
    } as never);
    await loadAllConfigs();
    expect(_isLoaded()).toBe(true);

    invalidateConfigCache();

    expect(_isLoaded()).toBe(false);
    expect(_cacheSize()).toBe(0);
  });
});

// ── deleteConfig ────────────────────────────────────────────────────

describe("deleteConfig", () => {
  it("throws for predefined keys", async () => {
    await expect(deleteConfig("sandbox.timeout")).rejects.toThrow(
      "Cannot delete predefined config key",
    );
  });
});

// ── defaults integrity ──────────────────────────────────────────────

describe("CONFIG_DEFAULTS integrity", () => {
  it("has no duplicate keys", () => {
    const keys = CONFIG_DEFAULTS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry has required fields", () => {
    for (const d of CONFIG_DEFAULTS) {
      expect(d.key).toBeTruthy();
      expect(d.value).toBeDefined();
      expect(["string", "number", "boolean", "json"]).toContain(d.valueType);
      expect(d.description).toBeTruthy();
    }
  });

  it("keys follow dot-notation pattern", () => {
    for (const d of CONFIG_DEFAULTS) {
      expect(d.key).toMatch(/^[a-z][a-z0-9_.]+$/);
    }
  });
});
