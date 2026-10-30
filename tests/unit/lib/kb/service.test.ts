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

import { KbPageTable } from "@/lib/db/schema";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http/route-handlers";
import type { MockDrizzleDb } from "tests/unit/helpers";
import {
  createCollection,
  createPage,
  deleteCollection,
  deleteFolder,
  deletePage,
  getPage,
  getPages,
  listCollections,
  renameFolder,
  updateCollection,
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

/**
 * The collection's address set — the rows every write reads before it commits,
 * because a folder exists only as a prefix of these paths.
 */
function pageRows(...paths: string[]): Array<{ id: number; path: string }> {
  return paths.map((path, index) => ({ id: index + 1, path }));
}

/** The same set with ids chosen, for assertions on which rows a rewrite touched. */
function pageRowsByIds(
  ...rows: Array<[number, string]>
): Array<{ id: number; path: string }> {
  return rows.map(([id, path]) => ({ id, path }));
}

/** `{collectionId, path}` — the one read that backs the panel's tallies. */
function pathRows(
  collectionId: string,
  ...paths: string[]
): Array<{ collectionId: string; path: string }> {
  return paths.map((path) => ({ collectionId, path }));
}

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 21,
    collectionId: COLLECTION_ID,
    path: "chapter-01/install",
    description: null,
    content: "body",
    contentType: "text/markdown",
    size: 4,
    sourceRef: null,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    ...overrides,
  };
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

/** The paths the rewrite wrote, in the order the subtree was walked. */
function rewrittenPaths(): string[] {
  return dbMock._chain.set.mock.calls.map(
    (call) => (call[0] as { path: string }).path,
  );
}

beforeEach(() => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  dbMock.$reset();
});

describe("kb/service — collection reads", () => {
  it("derives both tallies for each collection from one path read", async () => {
    dbMock.$enqueue(
      [
        { id: COLLECTION_ID, name: "x-manual", description: "Manual." },
        { id: OTHER_COLLECTION_ID, name: "team-notes" },
      ],
      // One read for the whole set: a nested folder counts once toward its
      // level-1 parent, a loose page counts nowhere, and the second
      // collection's bucket comes out of the same rows.
      [
        ...pathRows(
          COLLECTION_ID,
          "chapter-10/a",
          "chapter-2/b",
          "chapter-2/x/y",
          "loose",
        ),
        ...pathRows(OTHER_COLLECTION_ID, "notes/one"),
      ],
    );

    const rows = await listCollections(SESSION);

    expect(rows.map((r) => [r.folderCount, r.pageCount])).toEqual([
      [2, 4],
      [1, 1],
    ]);
  });

  it("gives a collection with no pages zero of both, without a per-collection query", async () => {
    dbMock.$enqueue(
      [{ id: COLLECTION_ID, name: "empty" }],
      pathRows(OTHER_COLLECTION_ID, "notes/one"),
    );

    const [row] = await listCollections(SESSION);

    expect([row.folderCount, row.pageCount]).toEqual([0, 0]);
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });

  it("skips the path read for an empty list", async () => {
    dbMock.$enqueue([]);
    expect(await listCollections(SESSION)).toEqual([]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it("natural-sorts the page list after the SQL read", async () => {
    // Simulates what Postgres returns without COLLATE: byte order.
    dbMock.$enqueue([
      { path: "chapter-10" },
      { path: "chapter-2" },
      { path: "chapter-2-images" },
    ]);

    const pages = await getPages(COLLECTION_ID);

    expect(pages.map((p) => p.path)).toEqual([
      "chapter-2",
      "chapter-2-images",
      "chapter-10",
    ]);
  });

  it("reads a page by path and 404s one the collection does not hold", async () => {
    dbMock.$enqueue([]);
    await expectApiError(() => getPage(COLLECTION_ID, "chapter-01/nope"), {
      code: "NOT_FOUND",
      status: 404,
    });

    dbMock.$resolveWith([pageRow({ content: "the body" })]);
    expect((await getPage(COLLECTION_ID, "chapter-01/install")).content).toBe(
      "the body",
    );
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

  it("refuses a NUL byte in collection prose before any query", async () => {
    await expectApiError(
      () =>
        createCollection({
          name: "x-manual",
          description: "bad\u0000description",
          createdBy: ACTOR_ID,
        }),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_TEXT" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
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

describe("kb/service — page writes", () => {
  const body = "# Install\n\nRun `make up`.\n";

  it("stores the path verbatim, measures `size` in UTF-8 bytes and defaults the content type", async () => {
    dbMock.$enqueue([], [pageRow()]);

    await createPage(
      COLLECTION_ID,
      { path: "chapter-01/裸机安装.md", content: body },
      ACTOR_ID,
    );

    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: COLLECTION_ID,
        path: "chapter-01/裸机安装.md",
        size: Buffer.byteLength(body, "utf8"),
        contentType: "text/markdown",
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
      }),
    );
  });

  it("rejects an illegal path before reading the collection's addresses", async () => {
    await expectApiError(
      () => createPage(COLLECTION_ID, { path: "a/b/c/leaf", content: body }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_PATH" },
    );
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("catches a control byte in the path as a path problem, not a text problem", async () => {
    const err = await expectApiError(
      () => createPage(COLLECTION_ID, { path: "bad\u0000name", content: body }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_PATH" },
    );
    expect(err.message).toContain("Page path");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses a page that would land inside an existing page", async () => {
    dbMock.$enqueue(pageRows("chapter-01"));

    const err = await expectApiError(
      () => createPage(COLLECTION_ID, { path: "chapter-01/install", content: body }, ACTOR_ID),
      { code: "CONFLICT", status: 409, reason: "PATH_TAKEN" },
    );
    expect(err.message).toContain("chapter-01/install");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses a page whose name an existing folder already owns", async () => {
    dbMock.$enqueue(pageRows("chapter-01/install"));

    await expectApiError(
      () => createPage(COLLECTION_ID, { path: "chapter-01", content: body }, ACTOR_ID),
      { code: "CONFLICT", status: 409, reason: "PATH_TAKEN" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("turns a unique-violation race into the same 409 PATH_TAKEN", async () => {
    dbMock.$enqueue([]);
    dbMock._chain.returning.mockRejectedValueOnce(UNIQUE_VIOLATION);

    await expectApiError(
      () => createPage(COLLECTION_ID, { path: "chapter-01/install", content: body }, ACTOR_ID),
      { code: "CONFLICT", status: 409, reason: "PATH_TAKEN" },
    );
  });

  it("refuses the insert at the configured page ceiling", async () => {
    mockConfig["kb.max_pages"] = "3";
    dbMock.$enqueue(pageRows("a", "b", "c"));

    const err = await expectApiError(
      () => createPage(COLLECTION_ID, { path: "d", content: body }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "LIMIT_REACHED" },
    );
    expect((err.details as Record<string, unknown>).kind).toBe("page");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses a write that would push the collection over its folder budget", async () => {
    mockConfig["kb.max_folders"] = "2";
    dbMock.$enqueue(pageRows("a/x", "b/y"));

    const err = await expectApiError(
      () => createPage(COLLECTION_ID, { path: "c/z", content: body }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "LIMIT_REACHED" },
    );
    const details = err.details as Record<string, unknown>;
    expect(details.kind).toBe("folder");
    expect(details.count).toBe(3);
    expect(details.max).toBe(2);
    expect(err.message).toContain("kb.max_folders");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("lets a page join a folder the collection already has while at the budget", async () => {
    mockConfig["kb.max_folders"] = "2";
    dbMock.$enqueue(pageRows("a/x", "b/y"), [pageRow()]);

    await createPage(COLLECTION_ID, { path: "a/z", content: body }, ACTOR_ID);

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it("charges CJK prose by byte, not by character", async () => {
    mockConfig["kb.page_max_bytes"] = "12";
    dbMock.$enqueue([]);

    const err = await expectApiError(
      () => createPage(COLLECTION_ID, { path: "notes", content: "知识库知识" }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "PAGE_TOO_LARGE" },
    );
    const details = err.details as Record<string, number>;
    expect(details.sizeBytes).toBe(15);
    expect(details.maxBytes).toBe(12);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses an unpaired surrogate before Postgres can reject the row", async () => {
    dbMock.$enqueue([]);
    await expectApiError(
      () => createPage(COLLECTION_ID, { path: "broken", content: "ok \uD800 tail" }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_TEXT" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses a NUL byte in content before Postgres can reject the row", async () => {
    dbMock.$enqueue([]);
    await expectApiError(
      () => createPage(COLLECTION_ID, { path: "nul", content: "ok\u0000tail" }, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_TEXT" },
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses a NUL byte in the page description before any query", async () => {
    await expectApiError(
      () =>
        createPage(
          COLLECTION_ID,
          { path: "desc", description: "bad\u0000desc", content: body },
          ACTOR_ID,
        ),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_TEXT" },
    );
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("accepts a NUL byte in source_ref — provenance is exempt from text validation", async () => {
    dbMock.$enqueue([], [pageRow()]);

    await createPage(
      COLLECTION_ID,
      { path: "nul-src", content: body, sourceRef: "note\u0000nul" },
      ACTOR_ID,
    );

    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: "note\u0000nul" }),
    );
  });

  it("re-measures size when content changes and leaves it alone otherwise", async () => {
    const grown = "a much longer body than before, and it is UTF-8 too.";
    dbMock.$enqueue([pageRow()], [pageRow({ content: grown })]);

    await updatePage(COLLECTION_ID, "chapter-01/install", { content: grown }, ACTOR_ID);
    expect(dbMock._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ content: grown, size: Buffer.byteLength(grown, "utf8") }),
    );

    dbMock.$enqueue([pageRow()], [pageRow()]);
    dbMock._chain.set.mockClear();
    await updatePage(
      COLLECTION_ID,
      "chapter-01/install",
      { description: null },
      ACTOR_ID,
    );
    const sets = dbMock._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(sets.content).toBeUndefined();
    expect(sets.size).toBeUndefined();
    expect(sets.updatedBy).toBe(ACTOR_ID);
  });

  it("puts one field in charge of both renaming and moving", async () => {
    dbMock.$enqueue(
      [pageRow()],
      pageRows("chapter-02/config"),
      [pageRow({ path: "chapter-02/install" })],
    );

    await updatePage(
      COLLECTION_ID,
      "chapter-01/install",
      { path: "chapter-02/install" },
      ACTOR_ID,
    );

    expect(dbMock._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: "chapter-02/install" }),
    );
  });

  it("refuses a move onto an existing page or folder", async () => {
    dbMock.$enqueue([pageRow()], pageRows("chapter-02/install", "chapter-02/arch"));

    await expectApiError(
      () =>
        updatePage(
          COLLECTION_ID,
          "chapter-01/install",
          { path: "chapter-02/install" },
          ACTOR_ID,
        ),
      { code: "CONFLICT", status: 409, reason: "PATH_TAKEN" },
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("skips the address re-read when the new path is the current one", async () => {
    dbMock.$enqueue([pageRow()], [pageRow()]);

    await updatePage(
      COLLECTION_ID,
      "chapter-01/install",
      { path: "chapter-01/install", description: "same place" },
      ACTOR_ID,
    );

    expect(dbMock.select).toHaveBeenCalledTimes(1);
    const sets = dbMock._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(sets.path).toBeUndefined();
  });

  it("404s a path the collection does not hold before any mutation", async () => {
    dbMock.$enqueue([]);
    await expectApiError(
      () => updatePage(COLLECTION_ID, "chapter-01/nope", { content: body }, ACTOR_ID),
      { code: "NOT_FOUND", status: 404 },
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("refuses an empty page patch without reading the row", async () => {
    await expectApiError(
      () => updatePage(COLLECTION_ID, "chapter-01/install", {}, ACTOR_ID),
      { code: "BAD_REQUEST", status: 400 },
    );
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("deletes a page only after confirming its path is in this collection", async () => {
    dbMock.$enqueue([]);
    await expectApiError(() => deletePage(COLLECTION_ID, "chapter-01/nope"), {
      code: "NOT_FOUND",
      status: 404,
    });
    expect(dbMock.delete).not.toHaveBeenCalled();

    dbMock.$enqueue([pageRow()]);
    await deletePage(COLLECTION_ID, "chapter-01/install");
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    expect(dbMock.delete.mock.calls[0][0]).toBe(KbPageTable);
  });
});

describe("kb/service — folder rename rewrites the subtree", () => {
  it("rewrites every page under the prefix and reports how many", async () => {
    dbMock.$enqueue(
      pageRowsByIds(
        [1, "chapter-01/install"],
        [2, "chapter-01/images/build"],
        [3, "chapter-02/config"],
      ),
    );

    const rewritten = await renameFolder(
      COLLECTION_ID,
      "chapter-01",
      "appendix",
      ACTOR_ID,
    );

    expect(rewritten).toBe(2);
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(rewrittenPaths()).toEqual([
      "appendix/install",
      "appendix/images/build",
    ]);
    expect(dbMock._chain.set.mock.calls[0][0]).toMatchObject({
      updatedBy: ACTOR_ID,
    });
    // The row outside the subtree keeps its address: only two writes ran.
    expect(dbMock._chain.set).toHaveBeenCalledTimes(2);
  });

  it("404s a prefix no page carries, before any write", async () => {
    dbMock.$enqueue(pageRows("chapter-01/install"));

    const err = await expectApiError(
      () => renameFolder(COLLECTION_ID, "chapter-09", "x", ACTOR_ID),
      { code: "NOT_FOUND", status: 404 },
    );
    expect(err.message).toContain("chapter-09");
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("refuses a prefix-only rename whose target nests too deep", async () => {
    await expectApiError(
      () => renameFolder(COLLECTION_ID, "chapter-01", "a/b/c", ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_PATH" },
    );
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("refuses a move that would push a page past the depth cap", async () => {
    dbMock.$enqueue(pageRows("chapter-01/images/build"));

    // `chapter-01` → `chapter-01/cover` is legal as a prefix, but the page
    // under it would then sit three folders deep.
    await expectApiError(
      () => renameFolder(COLLECTION_ID, "chapter-01", "chapter-01/cover", ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "INVALID_PATH" },
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("refuses a rewrite that would land on a page outside the subtree", async () => {
    dbMock.$enqueue(
      pageRowsByIds([1, "chapter-01/install"], [2, "chapter-02/install"]),
    );

    await expectApiError(
      () => renameFolder(COLLECTION_ID, "chapter-01", "chapter-02", ACTOR_ID),
      { code: "CONFLICT", status: 409, reason: "PATH_TAKEN" },
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("checks the folder budget on the post-rewrite set, so a swap stays legal", async () => {
    mockConfig["kb.max_folders"] = "2";
    dbMock.$enqueue(pageRowsByIds([1, "a/x"], [2, "b/y"]));

    // `a` gives up its prefix as `c` takes one: still two folders afterwards.
    expect(await renameFolder(COLLECTION_ID, "a", "c", ACTOR_ID)).toBe(1);
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a rewrite that would add folders beyond the budget", async () => {
    mockConfig["kb.max_folders"] = "2";
    dbMock.$enqueue(pageRowsByIds([1, "a/x"], [2, "b/y"]));

    const err = await expectApiError(
      () => renameFolder(COLLECTION_ID, "a", "c/d", ACTOR_ID),
      { code: "BAD_REQUEST", status: 400, reason: "LIMIT_REACHED" },
    );
    expect((err.details as Record<string, unknown>).kind).toBe("folder");
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("lifts a subtree to the collection root by rewriting to the empty prefix", async () => {
    dbMock.$enqueue(pageRowsByIds([1, "chapter-01/install"], [2, "chapter-01/config"]));

    expect(await renameFolder(COLLECTION_ID, "chapter-01", "", ACTOR_ID)).toBe(2);
    expect(rewrittenPaths()).toEqual(["install", "config"]);
  });
});

describe("kb/service — folder delete takes the subtree", () => {
  it("deletes every page under the prefix, nested folders included", async () => {
    dbMock.$enqueue(
      pageRowsByIds(
        [1, "chapter-01/install"],
        [2, "chapter-01/images/build"],
        [3, "other"],
      ),
    );

    expect(await deleteFolder(COLLECTION_ID, "chapter-01")).toBe(2);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    expect(dbMock.delete.mock.calls[0][0]).toBe(KbPageTable);
  });

  it("404s a prefix no page carries instead of deleting nothing", async () => {
    dbMock.$enqueue(pageRows("chapter-01/install"));

    await expectApiError(() => deleteFolder(COLLECTION_ID, "chapter-09"), {
      code: "NOT_FOUND",
      status: 404,
    });
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("refuses the root prefix, which would empty the collection by name", async () => {
    dbMock.$enqueue(pageRows("install"));

    await expectApiError(() => deleteFolder(COLLECTION_ID, ""), {
      code: "NOT_FOUND",
      status: 404,
    });
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});
