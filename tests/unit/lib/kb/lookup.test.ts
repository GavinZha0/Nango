import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";
import {
  getKbPageByPath,
  listEnabledKbCollectionsByIds,
  listKbIndexPages,
  listKbPagePathsByIds,
  resolveKbCollectionForAgent,
} from "@/lib/kb/lookup";

const dbMock = db as unknown as MockDrizzleDb;

const COLLECTION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  dbMock.$reset();
});

describe("kb/lookup — collection resolution", () => {
  it("runs no query when the agent binds nothing", async () => {
    expect(await listEnabledKbCollectionsByIds([])).toEqual([]);
    expect(await listKbPagePathsByIds([])).toEqual([]);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("orders the mounted collections with the shared natural comparator", async () => {
    dbMock.$enqueue([
      { id: "1", name: "manual-10", description: null },
      { id: "2", name: "manual-2", description: null },
    ]);

    const rows = await listEnabledKbCollectionsByIds(["1", "2"]);
    expect(rows.map((r) => r.name)).toEqual(["manual-2", "manual-10"]);
  });

  it("resolves a slug only when its id is in the agent's bound set", async () => {
    dbMock.$enqueue([{ id: OTHER_ID, name: "x-manual", description: "Manual." }]);
    // The name matched a real, enabled row, but that row is bound to a
    // different agent: the answer is the same null an unknown slug gets.
    expect(await resolveKbCollectionForAgent("x-manual", new Set([COLLECTION_ID]))).toBeNull();

    dbMock.$enqueue([{ id: COLLECTION_ID, name: "x-manual", description: "Manual." }]);
    expect(
      await resolveKbCollectionForAgent("x-manual", new Set([COLLECTION_ID])),
    ).toEqual({ id: COLLECTION_ID, name: "x-manual", description: "Manual." });
  });

  it("does not query for an empty binding set", async () => {
    expect(await resolveKbCollectionForAgent("x-manual", new Set())).toBeNull();
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe("kb/lookup — prompt-block paths", () => {
  it("ships every path of the bound set from one read, buckets included", async () => {
    dbMock.$enqueue([
      { collectionId: COLLECTION_ID, path: "chapter-02/a" },
      { collectionId: COLLECTION_ID, path: "chapter-10/a" },
      { collectionId: OTHER_ID, path: "notes" },
    ]);

    const rows = await listKbPagePathsByIds([COLLECTION_ID, OTHER_ID]);

    // The block derives folders in JS, so this read stays raw: no ordering, no
    // description, no body.
    expect(rows).toEqual([
      { collectionId: COLLECTION_ID, path: "chapter-02/a" },
      { collectionId: COLLECTION_ID, path: "chapter-10/a" },
      { collectionId: OTHER_ID, path: "notes" },
    ]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    const selection = dbMock.select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(selection)).toEqual(["collectionId", "path"]);
  });
});

describe("kb/lookup — derived index", () => {
  it("natural-sorts the paths after the SQL read", async () => {
    dbMock.$enqueue([
      { path: "chapter-10", description: null },
      { path: "chapter-2", description: "Two." },
      { path: "chapter-2-images", description: null },
    ]);

    const pages = await listKbIndexPages(COLLECTION_ID);

    expect(pages.map((p) => p.path)).toEqual([
      "chapter-2",
      "chapter-2-images",
      "chapter-10",
    ]);
  });

  it("never ships a page body in the index", async () => {
    dbMock.$enqueue([{ path: "a", description: null }]);

    const pages = await listKbIndexPages(COLLECTION_ID);

    expect(pages[0]).toEqual({ path: "a", description: null });
    const selection = dbMock.select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(selection)).toEqual(["path", "description"]);
  });
});

describe("kb/lookup — page body fetch", () => {
  it("selects the four agent-visible columns and no provenance", async () => {
    dbMock.$enqueue([
      {
        path: "chapter-01/install",
        description: null,
        content: "body",
        contentType: "text/markdown",
      },
    ]);

    const page = await getKbPageByPath(COLLECTION_ID, "chapter-01/install");

    expect(page?.content).toBe("body");
    const selection = dbMock.select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(selection)).toEqual([
      "path",
      "description",
      "content",
      "contentType",
    ]);
    expect(selection).not.toHaveProperty("sourceRef");
  });

  it("returns null for a path this collection does not hold", async () => {
    dbMock.$enqueue([]);
    expect(await getKbPageByPath(COLLECTION_ID, "nope")).toBeNull();
  });
});
