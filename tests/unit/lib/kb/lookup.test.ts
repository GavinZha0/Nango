import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";
import {
  countKbPagesByGroup,
  getKbIndex,
  getKbPageByName,
  listEnabledKbCollectionsByIds,
  listKbGroupLinesByIds,
  resolveKbCollectionForAgent,
} from "@/lib/kb/lookup";

const dbMock = db as unknown as MockDrizzleDb;

const COLLECTION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

interface GroupRow {
  collectionId: string;
  id: number;
  name: string;
  parentId: number | null;
  description: string | null;
}

function groupRow(overrides: Partial<GroupRow> & { id: number; name: string }): GroupRow {
  return {
    collectionId: COLLECTION_ID,
    parentId: null,
    description: "Chapter body.",
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.$reset();
});

describe("kb/lookup — collection resolution", () => {
  it("runs no query when the agent binds nothing", async () => {
    expect(await listEnabledKbCollectionsByIds([])).toEqual([]);
    expect(await listKbGroupLinesByIds([])).toEqual([]);
    expect(await countKbPagesByGroup([])).toEqual([]);
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

describe("kb/lookup — prompt-block counts", () => {
  it("counts pages per group in one grouped read", async () => {
    dbMock.$enqueue([
      { collectionId: COLLECTION_ID, groupId: 1, count: 3 },
      { collectionId: COLLECTION_ID, groupId: null, count: 2 },
    ]);

    const rows = await countKbPagesByGroup([COLLECTION_ID]);

    expect(rows).toEqual([
      { collectionId: COLLECTION_ID, groupId: 1, count: 3 },
      { collectionId: COLLECTION_ID, groupId: null, count: 2 },
    ]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(dbMock._chain.groupBy).toHaveBeenCalledTimes(1);
  });
});

describe("kb/lookup — derived index", () => {
  it("prints each level-1 group immediately followed by its children", async () => {
    dbMock.$enqueue(
      [
        groupRow({ id: 3, name: "chapter-2" }),
        groupRow({ id: 1, name: "chapter-10" }),
        groupRow({ id: 4, name: "b-appendix", parentId: 1 }),
        groupRow({ id: 5, name: "a-install", parentId: 1 }),
      ],
      [],
    );

    const index = await getKbIndex(COLLECTION_ID);

    expect(index.groups.map((g) => [g.name, g.parentName])).toEqual([
      ["chapter-2", null],
      ["chapter-10", null],
      ["a-install", "chapter-10"],
      ["b-appendix", "chapter-10"],
    ]);
  });

  it("buckets pages under their group and keeps root pages in the ungrouped tail", async () => {
    dbMock.$enqueue(
      [groupRow({ id: 1, name: "chapter-01" })],
      [
        { name: "notes-2", description: null, groupId: null },
        { name: "install", description: "How to install.", groupId: 1 },
        { name: "notes-10", description: null, groupId: null },
        { name: "config", description: null, groupId: 1 },
        { name: "orphans-only", description: null, groupId: 99 },
      ],
    );

    const index = await getKbIndex(COLLECTION_ID);

    expect(index.groups[0].pages.map((p) => p.name)).toEqual(["config", "install"]);
    expect(index.ungroupedPages.map((p) => p.name)).toEqual(["notes-2", "notes-10"]);
    // A page whose group row is outside this collection's read is unreachable:
    // no group line names it and it is not in the ungrouped tail.
    const reachable = [
      ...index.groups.flatMap((g) => g.pages.map((p) => p.name)),
      ...index.ungroupedPages.map((p) => p.name),
    ];
    expect(reachable).not.toContain("orphans-only");
  });

  it("never ships a page body in the index", async () => {
    dbMock.$enqueue([], [{ name: "a", description: null, groupId: null }]);
    const index = await getKbIndex(COLLECTION_ID);

    expect(index.ungroupedPages[0]).toEqual({ name: "a", description: null });
    const pageSelection = dbMock.select.mock.calls[1][0] as Record<string, unknown>;
    expect(Object.keys(pageSelection)).toEqual(["name", "description", "groupId"]);
  });

  it("reads groups and pages for one collection in two queries", async () => {
    dbMock.$enqueue([], []);
    await getKbIndex(COLLECTION_ID);
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });
});

describe("kb/lookup — page body fetch", () => {
  it("selects the four agent-visible columns and no provenance", async () => {
    dbMock.$enqueue([
      {
        name: "install",
        description: null,
        content: "body",
        contentType: "text/markdown",
      },
    ]);

    const page = await getKbPageByName(COLLECTION_ID, "install");

    expect(page?.content).toBe("body");
    const selection = dbMock.select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(selection)).toEqual([
      "name",
      "description",
      "content",
      "contentType",
    ]);
    expect(selection).not.toHaveProperty("sourceRef");
  });

  it("returns null for a name that is not in this collection", async () => {
    dbMock.$enqueue([]);
    expect(await getKbPageByName(COLLECTION_ID, "nope")).toBeNull();
  });
});
