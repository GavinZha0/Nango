import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// buildUserToolCatalog now queries owner-visible data sources (BUG-1)
// to scope the extract_dataset_by_sql allowed set. Stub the DB read.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([] as Array<{ id: string }>),
      }),
    }),
  },
}));

import { buildUserToolCatalog } from "@/lib/builtin-tools/build-user-catalog";
import { BUILTIN_TOOLS } from "@/lib/builtin-tools/catalog";

// ─── Shape ────────────────────────────────────────────────────────────

describe("buildUserToolCatalog — shape", () => {
  it("returns a Map keyed by tool name", async () => {
    const catalog = await buildUserToolCatalog("user-1");
    expect(catalog).toBeInstanceOf(Map);
    for (const [key, value] of catalog) {
      expect(typeof key).toBe("string");
      expect(value).toBeDefined();
      expect(typeof (value as { execute?: unknown }).execute).toBe("function");
    }
  });

  it("returns a fresh Map per call (no shared state)", async () => {
    const a = await buildUserToolCatalog("user-1");
    const b = await buildUserToolCatalog("user-1");
    expect(a).not.toBe(b);
  });
});

// ─── Catalog tool coverage ────────────────────────────────────────────

describe("buildUserToolCatalog — catalog tools", () => {
  it("includes every entry from BUILTIN_TOOLS", async () => {
    const catalog = await buildUserToolCatalog("user-1");
    for (const entry of BUILTIN_TOOLS) {
      expect(catalog.has(entry.name)).toBe(true);
    }
  });

  it("uses the entry's `build()` factory output", async () => {
    const catalog = await buildUserToolCatalog("user-1");
    for (const entry of BUILTIN_TOOLS) {
      const def = catalog.get(entry.name);
      expect(def).toBeDefined();
      // ToolDefinition shape (defineTool from @copilotkit/runtime/v2):
      // every catalog tool exposes an `execute` function.
      expect(typeof (def as { execute: unknown }).execute).toBe("function");
    }
  });
});

// ─── extract_dataset_by_sql (binding-implied global) ──────────────────

describe("buildUserToolCatalog — binding-implied tools", () => {
  it("includes extract_dataset_by_sql even with no agent bindings", async () => {
    // The tool is always present at the catalog layer; authorization is
    // enforced INSIDE the tool via its allowed-id set (BUG-1), here
    // scoped to the owner-visible data sources.
    const catalog = await buildUserToolCatalog("user-1");
    expect(catalog.has("extract_dataset_by_sql")).toBe(true);
  });
});

// ─── ownerId argument shape ───────────────────────────────────────────

describe("buildUserToolCatalog — ownerId arg", () => {
  it("accepts ownerId but doesn't differ by user (V1 catalog is owner-agnostic)", async () => {
    const a = await buildUserToolCatalog("user-1");
    const b = await buildUserToolCatalog("user-2");
    // Same keys (same tool universe across users in V1)
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  });
});

// ─── Unknown tool lookup ──────────────────────────────────────────────

describe("buildUserToolCatalog — unknown tool", () => {
  it("returns undefined for tools not in the catalog", async () => {
    const catalog = await buildUserToolCatalog("user-1");
    expect(catalog.get("ghost_tool")).toBeUndefined();
  });
});
