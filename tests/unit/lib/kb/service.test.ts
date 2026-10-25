import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig: Record<string, string> = {};
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: (key: string, defaultValue: string) => mockConfig[key] ?? defaultValue,
    getConfigNumber: (key: string, defaultValue: number) => {
      const raw = mockConfig[key];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    },
  };
});

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { KbGroupTable, KbPageTable, type KbGroupEntity } from "@/lib/db/schema";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http/route-handlers";
import type { MockDrizzleDb } from "tests/unit/helpers";
import {
  createCollection,
  createGroup,
  createPage,
  deleteCollection,
  deleteGroup,
  deletePage,
  getPage,
  getTree,
  listCollections,
  updateCollection,
  updateGroup,
  updatePage,
} from "@/lib/kb/service";

const dbMock = db as unknown as MockDrizzleDb;

const COLLECTION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_COLLECTION_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";

const SESSION = {
  user: { id: ACTOR_ID, role: "admin", email: "admin@example.com" },
  session: { id: "sess-1" },
} as never;

function group(overrides: Partial<KbGroupEntity> = {}): KbGroupEntity {
  return {
    id: 1,
    collectionId: COLLECTION_ID,
    parentId: null,
    name: "chapter-01",
    description: "Install paths for the product.",
    ...overrides,
  } as KbGroupEntity;
}

/** The `code: "23505"` shape Postgres sends for a unique-index violation. */
const UNIQUE_VIOLATION = Object.assign(new Error("duplicate key value"), {
  code: "23505",
});

async function expectApiError(
  action: () => Promise<unknown>,
  expected: { code: string; status: number; reason?: unknown },
): Promise<ApiError> {
  const err = await action().then(
    () => null,
    (rejected: unknown) => rejected,
  );
  expect(err).toBeInstanceOf(ApiError);
  const apiErr = err as ApiError;
  expect(apiErr.code).toBe(expected.code);
  expect(apiErr.status).toBe(expected.status);
  if (expected.reason !== undefined) {
    expect((apiErr.details as Record<string, unknown>).reason).toBe(expected.reason);
  }
  return apiErr;
}

beforeEach(() => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  dbMock.$reset();
});

describe("kb/service — collection reads", () => {
  it("pairs each collection with its level-1 group and page tallies", async () => {
    dbMock.$enqueue(
      [
        { id: COLLECTION_ID, name: "x-manual", description: "Manual." },
        { id: OTHER_COLLECTION_ID, name: "team-notes", description: "Notes." },
      ],
      // Both counters arrive sparse: a collection with no row in the grouped
      // result must read 0, not undefined.
      [{ collectionId: COLLECTION_ID, count: 3 }],
      [{ collectionId: OTHER_COLLECTION_ID, count: 12 }],
    );

    const rows = await listCollections(SESSION);

    expect(rows.map((r) => [r.topLevelGroupCount, r.pageCount])).toEqual([
      [3, 0],
      [0, 12],
    ]);
  });

  it("skips the count queries for an empty list", async () => {
    dbMock.$enqueue([]);
    expect(await listCollections(SESSION)).toEqual([]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it("natural-sorts both branches of the tree after the SQL read", async () => {
    // Simulates what Postgres returns without COLLATE: byte order.
    dbMock.$enqueue(
      [group({ id: 2, name: "chapter-10" }), group({ id: 1, name: "chapter-2" })],
      [
        { id: 11, name: "chapter-10", groupId: 2 },
        { id: 12, name: "chapter-2", groupId: 1 },
      ],
    );

    const tree = await getTree(COLLECTION_ID);

    expect(tree.groups.map((g) => g.name)).toEqual(["chapter-2", "chapter-10"]);
    expect(tree.pages.map((p) => p.name)).toEqual(["chapter-2", "chapter-10"]);
  });

  it("returns one page body or 404 for a page outside the collection", async () => {
    dbMock.$enqueue([]);
    await expectApiError(() => getPage(COLLECTION_ID, 99), {
      code: "NOT_FOUND",
      status: 404,
    });

    dbMock.$resolveWith([{ id: 99, name: "a-page", content: "body" }]);
    expect((await getPage(COLLECTION_ID, 99)).content).toBe("body");
  });
});

describe("kb/service — collection writes", () => {
  it("creates private by default and stamps both audit columns with the actor", async () => {
    dbMock.$enqueue([{ id: COLLECTION_ID, name: "x-manual" }]);

    await createCollection({
      name: "x-manual",
      description: "Installation manual for product X.",
      createdBy: ACTOR_ID,
    });

    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: "private",
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
      }),
    );
  });

  it("turns a unique violation into 409 NAME_TAKEN and leaves other errors alone", async () => {
    dbMock._chain.returning.mockRejectedValueOnce(UNIQUE_VIOLATION);
    const err = await expectApiError(
      () =>
        createCollection({
          name: "x-manual",
          description: "Installation manual for product X.",
          createdBy: ACTOR_ID,
        }),
      { code: "CONFLICT", status: 409, reason: "NAME_TAKEN" },
    );
    expect(err.message).toContain("x-manual");

    const other = new Error("connection lost");
    dbMock._chain.returning.mockRejectedValueOnce(other);
    await expect(
      createCollection({
        name: "x-manual",
        description: "Installation manual for product X.",
        createdBy: ACTOR_ID,
      }),
    ).rejects.toBe(other);
  });

  it("refuses an empty patch before touching the database", async () => {
    await expectApiError(() => updateCollection(COLLECTION_ID, {}, ACTOR_ID), {
      code: "BAD_REQUEST",
      status: 400,
    });
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("reports 404 when the update matches no row", async () => {
    dbMock.$enqueue([]);
    await expectApiError(
      () => updateCollection(COLLECTION_ID, { enabled: false }, ACTOR_ID),
      { code: "NOT_FOUND", status: 404 },
    );
  });

  it("deletes the collection row by id and nothing else", async () => {
    await deleteCollection(COLLECTION_ID);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    expect(dbMock._chain.where).toHaveBeenCalledTimes(1);
  });
});

describe("kb/service — group writes", () => {
  it("refuses a level-2 parent: depth is capped at two levels", async () => {
    dbMock.$enqueue([group({ id: 7, parentId: 3 })]);
    await expectApiError(
      () => createGroup(COLLECTION_ID, { name: "sub", description: "Nested one.", parentId: 7 }),
      { code: "BAD_REQUEST", status: 400, reason: "DEPTH_EXCEEDED" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses the insert at the configured group ceiling", async () => {
    mockConfig["kb.max_groups"] = "2";
    dbMock.$enqueue([{ count: 2 }]);

    await expectApiError(
      () => createGroup(COLLECTION_ID, { name: "third", description: "One too many." }),
      { code: "BAD_REQUEST", status: 400, reason: "LIMIT_REACHED" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("accepts a group below the ceiling and attaches it at level 1 by default", async () => {
    dbMock.$enqueue([{ count: 0 }], [{ id: 4, name: "chapter-04" }]);

    await createGroup(COLLECTION_ID, {
      name: "chapter-04",
      description: "Operations runbook.",
    });

    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: COLLECTION_ID, parentId: null }),
    );
  });

  it("404s a move whose target group is in another collection", async () => {
    dbMock.$enqueue([group({ id: 5 })], []);
    await expectApiError(
      () => updateGroup(COLLECTION_ID, 5, { parentId: 9 }),
      { code: "NOT_FOUND", status: 404 },
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("refuses a move into the moved group's own subtree", async () => {
    dbMock.$enqueue(
      [group({ id: 1, parentId: null })],
      [group({ id: 1, parentId: null }), group({ id: 2, parentId: 1 })],
    );
    await expectApiError(
      () => updateGroup(COLLECTION_ID, 1, { parentId: 2 }),
      { code: "BAD_REQUEST", status: 400, reason: "CYCLE_REJECTED" },
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("refuses a group that would become its own parent", async () => {
    dbMock.$enqueue([group({ id: 1, parentId: null })]);
    await expectApiError(
      () => updateGroup(COLLECTION_ID, 1, { parentId: 1 }),
      { code: "BAD_REQUEST", status: 400 },
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("refuses a move that would make a group with children level 2", async () => {
    dbMock.$enqueue(
      [group({ id: 1, parentId: null })],
      [
        group({ id: 1, parentId: null }),
        group({ id: 2, parentId: 1 }),
        group({ id: 3, parentId: null, name: "chapter-02" }),
      ],
    );
    await expectApiError(
      () => updateGroup(COLLECTION_ID, 1, { parentId: 3 }),
      { code: "BAD_REQUEST", status: 400, reason: "DEPTH_EXCEEDED" },
    );
  });

  it("lets a leaf group move under a level-1 group", async () => {
    dbMock.$enqueue(
      [group({ id: 1, parentId: null })],
      [
        group({ id: 1, parentId: null }),
        group({ id: 3, parentId: null, name: "chapter-02" }),
      ],
      [{ id: 1, parentId: 3 }],
    );

    const row = await updateGroup(COLLECTION_ID, 1, { parentId: 3 });
    expect(row.parentId).toBe(3);
  });

  it("sends only the fields the patch named", async () => {
    dbMock.$enqueue([group({ id: 1 })], [{ id: 1, name: "renamed" }]);

    await updateGroup(COLLECTION_ID, 1, { name: "renamed" });

    expect(dbMock._chain.set).toHaveBeenCalledWith({ name: "renamed" });
  });
});

describe("kb/service — deleting a group deletes its pages", () => {
  it("refuses while nested groups remain, and reports how many", async () => {
    dbMock.$enqueue([group({ id: 1 })], [{ count: 2 }]);

    const err = await expectApiError(() => deleteGroup(COLLECTION_ID, 1), {
      code: "CONFLICT",
      status: 409,
      reason: "GROUP_HAS_CHILDREN",
    });
    expect((err.details as Record<string, unknown>).childGroupCount).toBe(2);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("clears the group's pages before the group itself, in one transaction", async () => {
    dbMock.$enqueue([group({ id: 1 })], [{ count: 0 }]);

    await deleteGroup(COLLECTION_ID, 1);

    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.delete).toHaveBeenCalledTimes(2);
    expect(dbMock.delete.mock.calls[0][0]).toBe(KbPageTable);
    expect(dbMock.delete.mock.calls[1][0]).toBe(KbGroupTable);
  });

  it("404s a group id that is not in this collection before deleting anything", async () => {
    dbMock.$enqueue([]);
    await expectApiError(() => deleteGroup(COLLECTION_ID, 1), {
      code: "NOT_FOUND",
      status: 404,
    });
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});

describe("kb/service — page writes", () => {
  const body = "# Install\n\nRun `make up`.\n";

  it("measures `size` in stored UTF-8 bytes and defaults the content type", async () => {
    dbMock.$enqueue([{ count: 0 }], [{ id: 21, name: "install" }]);

    await createPage(
      COLLECTION_ID,
      { name: "install", content: body },
      ACTOR_ID,
    );

    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        size: Buffer.byteLength(body, "utf8"),
        contentType: "text/markdown",
        groupId: null,
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
      }),
    );
  });

  it("charges CJK prose by byte, not by character", async () => {
    mockConfig["kb.page_max_bytes"] = "12";
    dbMock.$enqueue([{ count: 0 }]);

    const err = await expectApiError(
      () => createPage(COLLECTION_ID, { name: "notes", content: "知识库知识" }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "PAGE_TOO_LARGE" },
    );
    const details = err.details as Record<string, number>;
    expect(details.sizeBytes).toBe(15);
    expect(details.maxBytes).toBe(12);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses an unpaired surrogate before Postgres can reject the row", async () => {
    dbMock.$enqueue([{ count: 0 }]);
    await expectApiError(
      () => createPage(COLLECTION_ID, { name: "broken", content: "ok \uD800 tail" }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_TEXT" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses the insert at the configured page ceiling", async () => {
    mockConfig["kb.max_pages"] = "50";
    dbMock.$enqueue([{ count: 50 }]);
    await expectApiError(
      () => createPage(COLLECTION_ID, { name: "fifty-first", content: body }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "LIMIT_REACHED" },
    );
  });

  it("turns a page name collision inside the collection into 409 NAME_TAKEN", async () => {
    dbMock.$enqueue([{ count: 0 }]);
    dbMock._chain.returning.mockRejectedValueOnce(UNIQUE_VIOLATION);

    await expectApiError(
      () => createPage(COLLECTION_ID, { name: "install", content: body }, ACTOR_ID),
      { code: "CONFLICT", status: 409, reason: "NAME_TAKEN" },
    );
  });

  it("rejects a groupId belonging to another collection as a malformed payload", async () => {
    dbMock.$enqueue([group({ id: 8, collectionId: OTHER_COLLECTION_ID })]);

    await expectApiError(
      () => createPage(COLLECTION_ID, { name: "misplaced", groupId: 8, content: body }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "GROUP_NOT_IN_COLLECTION" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("re-measures size when content changes and leaves it alone otherwise", async () => {
    const grown = "a much longer body than before, and it is UTF-8 too.";
    dbMock.$enqueue(
      [{ id: 21, content: "short", size: 5 }],
      [{ id: 21, content: grown, size: Buffer.byteLength(grown) }],
    );

    await updatePage(COLLECTION_ID, 21, { content: grown }, ACTOR_ID);
    expect(dbMock._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ size: Buffer.byteLength(grown, "utf8") }),
    );

    dbMock.$enqueue([{ id: 21, content: grown, size: 41 }], [{ id: 21 }]);
    dbMock._chain.set.mockClear();
    await updatePage(COLLECTION_ID, 21, { description: "now NULL" }, ACTOR_ID);
    const sets = dbMock._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(sets.content).toBeUndefined();
    expect(sets.size).toBeUndefined();
    expect(sets.updatedBy).toBe(ACTOR_ID);
  });

  it("validates the move target before writing a page patch", async () => {
    dbMock.$enqueue(
      [{ id: 21, content: "body", groupId: 1 }],
      [group({ id: 9, collectionId: OTHER_COLLECTION_ID })],
    );
    await expectApiError(
      () => updatePage(COLLECTION_ID, 21, { groupId: 9 }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "GROUP_NOT_IN_COLLECTION" },
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("404s a page id that is not in this collection before any mutation", async () => {
    dbMock.$enqueue([]);
    await expectApiError(
      () => updatePage(COLLECTION_ID, 21, { name: "renamed" }, ACTOR_ID),
      { code: "NOT_FOUND", status: 404 },
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("deletes a page only after confirming it exists in this collection", async () => {
    dbMock.$enqueue([]);
    await expectApiError(() => deletePage(COLLECTION_ID, 21), {
      code: "NOT_FOUND",
      status: 404,
    });
    expect(dbMock.delete).not.toHaveBeenCalled();

    dbMock.$enqueue([{ id: 21, content: "body" }]);
    await deletePage(COLLECTION_ID, 21);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
  });
});
