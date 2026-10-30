import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("@/lib/auth/auth-instance", () => ({ getSession: getSessionMock }));

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

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";
import { createMockRequest } from "tests/unit/helpers";
import {
  createMockSession,
  createMockUser,
  REGULAR_USER,
} from "tests/unit/fixtures";

import { POST as importKb } from "@/app/api/kb/import/route";

const dbMock = db as unknown as MockDrizzleDb;
const OWNER_ID = "user-owner-1";
const COLLECTION_ID = "11111111-1111-1111-1111-111111111111";
const noParams = { params: Promise.resolve({}) };

/** The `code: "23505"` shape Postgres sends for a unique-index violation. */
const UNIQUE_VIOLATION = Object.assign(new Error("duplicate key value"), {
  code: "23505",
});

type UploadEntry = { path: string; content: string | Buffer };

function manifest(
  entries: UploadEntry[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "x-manual",
    entries: entries.map((entry) => ({
      path: entry.path,
      contentBase64: Buffer.from(entry.content).toString("base64"),
    })),
    ...overrides,
  };
}

async function upload(body: Record<string, unknown> | unknown): Promise<Response> {
  return importKb(
    createMockRequest("/api/kb/import", { method: "POST", body }),
    noParams,
  );
}

/** The page rows the import handed to the second insert. */
function insertedPages(): Array<Record<string, unknown>> {
  return dbMock._chain.values.mock.calls[1][0] as Array<Record<string, unknown>>;
}

beforeEach(() => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  dbMock.$reset();
  dbMock.$enqueue([{ id: COLLECTION_ID, name: "x-manual" }], []);
  getSessionMock.mockResolvedValue(
    createMockSession(createMockUser({ id: OWNER_ID, role: "editor" })),
  );
});

describe("POST /api/kb/import — the gate and the envelope", () => {
  it("401s without a session and 403s a consumer", async () => {
    getSessionMock.mockResolvedValue(null);
    expect((await upload(manifest([{ path: "a.md", content: "x" }]))).status).toBe(401);

    getSessionMock.mockResolvedValue(createMockSession(REGULAR_USER));
    const res = await upload(manifest([{ path: "a.md", content: "x" }]));
    expect(res.status).toBe(403);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("takes only a name and a manifest, and refuses an illegal slug", async () => {
    // The description is no longer part of this body: the importer has not read
    // the corpus yet, so a smuggled one is an undeclared key.
    const prose = await upload(
      manifest([{ path: "a.md", content: "x" }], {
        description: "Installation manual for product X.",
      }),
    );
    expect(prose.status).toBe(400);

    const missing = await upload({
      entries: [{ path: "a.md", contentBase64: Buffer.from("x").toString("base64") }],
    });
    expect(missing.status).toBe(400);

    const slug = await upload(manifest([{ path: "a.md", content: "x" }], { name: "X Manual" }));
    expect(slug.status).toBe(400);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("takes a leading-digit slug, the same folder name skill would accept", async () => {
    const res = await upload(
      manifest([{ path: "a.md", content: "Prose.\n" }], { name: "2024-notes" }),
    );
    expect(res.status).toBe(201);
  });

  it("refuses a key the manifest does not carry", async () => {
    const res = await upload(
      manifest([{ path: "a.md", content: "x" }], { collectionId: COLLECTION_ID }),
    );
    expect(res.status).toBe(400);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/kb/import — a folder becomes a collection", () => {
  it("writes every text page with its hint and its own first paragraph", async () => {
    const res = await upload(
      manifest([
        { path: "README.md", content: "# X\n\nThe install manual for product X.\n" },
        { path: "chapter-01/build.md", content: "---\ntitle: Build\n---\n\nRun `make up`.\n" },
        { path: "chapter-01/errors.csv", content: "code,meaning\n7,nope\n" },
        { path: "config.json", content: '{"retries": 3}' },
      ]),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(COLLECTION_ID);
    expect(body.pagesImported).toBe(4);
    expect(body.skipped).toEqual([]);

    const pages = insertedPages();
    expect(pages.map((p) => p.path)).toEqual([
      "README.md",
      "chapter-01/build.md",
      "chapter-01/errors.csv",
      "config.json",
    ]);
    expect(pages.map((p) => p.description)).toEqual([
      "The install manual for product X.",
      "Run `make up`.",
      null,
      null,
    ]);
    expect(pages.map((p) => p.contentType)).toEqual([
      "text/markdown",
      "text/markdown",
      "text/csv",
      "application/json",
    ]);
    expect(pages.map((p) => p.size)).toEqual([
      Buffer.byteLength("# X\n\nThe install manual for product X.\n", "utf8"),
      Buffer.byteLength("---\ntitle: Build\n---\n\nRun `make up`.\n", "utf8"),
      Buffer.byteLength("code,meaning\n7,nope\n", "utf8"),
      Buffer.byteLength('{"retries": 3}', "utf8"),
    ]);
    // One collection row, one page set: the whole corpus is one grant to bind.
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });

  it("drops OS and tool noise and reports it instead of failing", async () => {
    const res = await upload(
      manifest([
        { path: ".DS_Store", content: "junk" },
        { path: "notes/.obsidian/workspace.json", content: "{}" },
        { path: "notes/old.md.bak", content: "junk" },
        { path: "notes/build.md", content: "Real prose here.\n" },
      ]),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesImported).toBe(1);
    expect(body.skipped).toEqual([
      ".DS_Store",
      "notes/.obsidian/workspace.json",
      "notes/old.md.bak",
    ]);
    expect(insertedPages().map((p) => p.path)).toEqual(["notes/build.md"]);
  });

  it("drops the images a documentation folder carries and imports the prose", async () => {
    const res = await upload(
      manifest([
        { path: "notes/build.md", content: "Real prose here.\n" },
        { path: "notes/images/architecture.png", content: "\u0089PNG junk" },
        { path: "notes/images/logo.jpg", content: "\u00FF\u00D8 junk" },
      ]),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pagesImported).toBe(1);
    // An image could never have been a page, so it is skipped and reported like
    // noise — the folder that contains it still imports.
    expect(body.skipped).toEqual([
      "notes/images/architecture.png",
      "notes/images/logo.jpg",
    ]);
    expect(insertedPages().map((p) => p.path)).toEqual(["notes/build.md"]);
  });

  it("creates a private, unpublished collection owned by the importer", async () => {
    await upload(manifest([{ path: "a.md", content: "Prose.\n" }]));

    expect(dbMock._chain.values.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: "x-manual",
        description: null,
        enabled: false,
        visibility: "private",
        createdBy: OWNER_ID,
        updatedBy: OWNER_ID,
      }),
    );
  });
});

describe("POST /api/kb/import — a foreign file fails the whole upload", () => {
  it("refuses a binary document with the shared reason", async () => {
    const res = await upload(manifest([{ path: "spec.pdf", content: "%PDF-1.4" }]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "PDF document",
    );
  });

  it("refuses bytes that are not UTF-8 rather than importing mojibake", async () => {
    const res = await upload(
      manifest([
        { path: "ok.md", content: "Prose.\n" },
        { path: "legacy.md", content: Buffer.from([0xc9, 0xe9, 0x20, 0xbd, 0xe9]) },
      ]),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "legacy.md",
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("refuses a NUL byte, which the walker owns", async () => {
    const res = await upload(
      manifest([{ path: "bad.md", content: Buffer.from("a\u0000b", "utf8") }]),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("NUL");
  });

  it("refuses a path the storage rules would reject, naming it", async () => {
    // Two folder levels are legal; a third is what the depth cap refuses.
    const deep = await upload(
      manifest([{ path: "a/b/c.md", content: "Prose.\n" }]),
    );
    expect(deep.status).toBe(201);

    const overDeep = await upload(
      manifest([{ path: "a/b/c/d.md", content: "Prose.\n" }]),
    );
    expect(overDeep.status).toBe(400);
    expect(((await overDeep.json()) as { message: string }).message).toContain(
      "a/b/c/d.md",
    );

    const escaped = await upload(manifest([{ path: "../escape.md", content: "x" }]));
    expect(escaped.status).toBe(400);
    expect(((await escaped.json()) as { message: string }).message).toContain(
      "../escape.md",
    );

    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a tree where a name is both a page and a folder", async () => {
    const res = await upload(
      manifest([
        { path: "install.md", content: "Prose.\n" },
        { path: "install.md/deep.md", content: "Prose.\n" },
      ]),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "both a file and a folder",
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("refuses a manifest that repeats one path", async () => {
    const res = await upload(
      manifest([
        { path: "notes/a.md", content: "First.\n" },
        { path: "notes/a.md", content: "Second.\n" },
      ]),
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain(
      "notes/a.md",
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/kb/import — budgets", () => {
  it("stops at the page cap while walking, before writing", async () => {
    mockConfig["kb.max_pages"] = "2";

    const res = await upload(
      manifest([
        { path: "a.md", content: "A.\n" },
        { path: "b.md", content: "B.\n" },
        { path: "c.md", content: "C.\n" },
      ]),
    );

    expect(res.status).toBe(413);
    expect(((await res.json()) as { message: string }).message).toContain(
      "2 file limit",
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("counts the folder budget over the whole tree, not one page", async () => {
    mockConfig["kb.max_folders"] = "1";

    const res = await upload(
      manifest([
        { path: "one/a.md", content: "A.\n" },
        { path: "two/b.md", content: "B.\n" },
      ]),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "kb.max_folders",
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("refuses a page larger than the stored-byte ceiling", async () => {
    mockConfig["kb.page_max_bytes"] = "8";

    const res = await upload(
      manifest([{ path: "a.md", content: "far more than eight bytes" }]),
    );

    expect(res.status).toBe(413);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("turns a collection-name collision into 409 without leaving pages behind", async () => {
    dbMock._chain.returning.mockRejectedValueOnce(UNIQUE_VIOLATION);

    const res = await upload(manifest([{ path: "a.md", content: "Prose.\n" }]));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("x-manual");
  });
});
