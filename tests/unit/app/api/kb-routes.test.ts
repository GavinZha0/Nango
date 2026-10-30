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
  ADMIN_USER,
  EDITOR_USER,
  REGULAR_USER,
} from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;

import { GET as listKb, POST as createKb } from "@/app/api/kb/route";
import {
  GET as getKb,
  PATCH as patchKb,
  DELETE as deleteKb,
} from "@/app/api/kb/[id]/route";
import { POST as createPage } from "@/app/api/kb/[id]/pages/route";
import {
  GET as getPageByPath,
  PATCH as patchByPath,
  DELETE as deleteByPath,
} from "@/app/api/kb/[id]/pages/[...path]/route";

const OWNER_ID = "user-owner-1";
const COLLECTION_ID = "11111111-1111-1111-1111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: COLLECTION_ID,
    name: "x-manual",
    description: "Installation manual for product X.",
    enabled: true,
    visibility: "private",
    createdBy: OWNER_ID,
    updatedBy: OWNER_ID,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    collectionId: COLLECTION_ID,
    path: "chapter-01/install",
    description: "How to install.",
    content: "the body",
    contentType: "text/markdown",
    size: 8,
    sourceRef: null,
    ...overrides,
  };
}

/** Handlers declare their own `params` shape, so the one-segment context is
 *  typed with `id` present rather than widened to a record. */
function params(extra?: Record<string, string>): {
  params: Promise<{ id: string } & Record<string, string>>;
} {
  return { params: Promise.resolve({ id: COLLECTION_ID, ...extra }) };
}

/** The catch-all arrives already split, one segment per path component. */
function pathParams(
  ...segments: string[]
): { params: Promise<{ id: string; path: string[] }> } {
  return { params: Promise.resolve({ id: COLLECTION_ID, path: segments }) };
}

const noParams = { params: Promise.resolve({}) };

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  dbMock.$reset();
  getSessionMock.mockResolvedValue(createMockSession(
    createMockUser({ id: OWNER_ID, role: "editor" }),
  ));
});

describe("GET /api/kb", () => {
  it("401s without a session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await listKb(createMockRequest("/api/kb"), noParams);
    expect(res.status).toBe(401);
  });

  it("ships the two tallies the left panel prints, derived from the page paths", async () => {
    dbMock.$enqueue(
      [row()],
      [
        { collectionId: COLLECTION_ID, path: "chapter-10/a" },
        { collectionId: COLLECTION_ID, path: "chapter-10/b/deep" },
        { collectionId: COLLECTION_ID, path: "loose" },
      ],
    );

    const body = await json(await listKb(createMockRequest("/api/kb"), noParams));

    expect(Array.isArray(body)).toBe(true);
    const item = (body as unknown as Array<Record<string, number>>)[0];
    expect(item.folderCount).toBe(1);
    expect(item.pageCount).toBe(3);
  });
});

describe("POST /api/kb", () => {
  it("403s a consumer role", async () => {
    getSessionMock.mockResolvedValue(createMockSession(REGULAR_USER));
    const res = await createKb(
      createMockRequest("/api/kb", {
        method: "POST",
        body: { name: "x-manual", description: "Installation manual for product X." },
      }),
      noParams,
    );
    expect(res.status).toBe(403);
  });

  it("refuses a slug an agent could not pass back as `kb_name`", async () => {
    for (const name of ["X-Manual", "manual with space", "-manual", "a".repeat(64)]) {
      const res = await createKb(
        createMockRequest("/api/kb", {
          method: "POST",
          body: { name, description: "Installation manual for product X." },
        }),
        noParams,
      );
      expect(res.status).toBe(400);
      expect(((await json(res)).code as string)).toBe("VALIDATION_FAILED");
    }
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("takes a folder-shaped slug that starts with a digit, as skill does", async () => {
    dbMock.$enqueue([row({ name: "2024-notes", createdBy: OWNER_ID })]);

    const res = await createKb(
      createMockRequest("/api/kb", {
        method: "POST",
        body: { name: "2024-notes", description: "Meeting notes for 2024." },
      }),
      noParams,
    );
    expect(res.status).toBe(201);
  });

  it("accepts an empty description, which the service stores as unpublished", async () => {
    dbMock.$enqueue([row({ description: null, enabled: false })]);

    const res = await createKb(
      createMockRequest("/api/kb", { method: "POST", body: { name: "x-manual" } }),
      noParams,
    );

    expect(res.status).toBe(201);
    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ description: null, enabled: false }),
    );
  });

  it("refuses a body field the schema does not declare", async () => {
    const res = await createKb(
      createMockRequest("/api/kb", {
        method: "POST",
        body: {
          name: "x-manual",
          description: "Installation manual for product X.",
          content: "smuggled",
        },
      }),
      noParams,
    );
    expect(res.status).toBe(400);
  });

  it("creates privately and attributes the row to the caller", async () => {
    dbMock.$enqueue([row({ createdBy: OWNER_ID })]);

    const res = await createKb(
      createMockRequest("/api/kb", {
        method: "POST",
        body: { name: "x-manual", description: "Installation manual for product X." },
      }),
      noParams,
    );

    expect(res.status).toBe(201);
    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: OWNER_ID, visibility: "private" }),
    );
  });
});

describe("GET /api/kb/[id]", () => {
  it("404s a malformed id before querying", async () => {
    const res = await getKb(createMockRequest("/api/kb/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("404s a private collection the caller cannot see, so ids stay opaque", async () => {
    getSessionMock.mockResolvedValue(createMockSession(EDITOR_USER));
    dbMock.$enqueue([row({ visibility: "private", createdBy: OWNER_ID })]);

    const res = await getKb(createMockRequest(`/api/kb/${COLLECTION_ID}`), params());
    expect(res.status).toBe(404);
  });

  it("ships pages without bodies and no folder payload", async () => {
    dbMock.$enqueue(
      [row()],
      [
        { path: "chapter-10", id: 12 },
        { path: "chapter-2", id: 11 },
        { path: "chapter-2-images", id: 13 },
      ],
    );

    const body = (await json(
      await getKb(createMockRequest(`/api/kb/${COLLECTION_ID}`), params()),
    )) as Record<string, unknown>;

    // The editor derives its tree from these paths, so there is nothing here to
    // disagree with them.
    expect(body.groups).toBeUndefined();
    expect((body.pages as Array<{ path: string }>).map((p) => p.path)).toEqual([
      "chapter-2",
      "chapter-2-images",
      "chapter-10",
    ]);
    // The tree read never projects `content`, so a 50-page collection stays small.
    const pageSelection = dbMock.select.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(pageSelection).not.toHaveProperty("content");
  });
});

describe("PATCH /api/kb/[id]", () => {
  it("lets an editor improve prose on a public collection they do not own", async () => {
    getSessionMock.mockResolvedValue(createMockSession(EDITOR_USER));
    dbMock.$enqueue(
      [row({ visibility: "public", createdBy: OWNER_ID })],
      [row({ visibility: "public", description: "Better routing prose." })],
      [row({ visibility: "public", description: "Better routing prose." })],
    );

    const res = await patchKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, {
        method: "PATCH",
        body: { description: "Better routing prose for the manual." },
      }),
      params(),
    );
    expect(res.status).toBe(200);
  });

  it("refuses to unmount or re-share a public collection the caller did not author", async () => {
    getSessionMock.mockResolvedValue(createMockSession(EDITOR_USER));

    for (const body of [{ enabled: false }, { visibility: "private" }]) {
      dbMock.$enqueue([row({ visibility: "public", createdBy: OWNER_ID })]);
      const res = await patchKb(
        createMockRequest(`/api/kb/${COLLECTION_ID}`, { method: "PATCH", body }),
        params(),
      );
      expect(res.status).toBe(403);
    }
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("lets an admin disable a collection", async () => {
    getSessionMock.mockResolvedValue(createMockSession(ADMIN_USER));
    dbMock.$enqueue(
      [row({ createdBy: OWNER_ID })],
      [row()],
      [row({ enabled: false })],
    );

    const res = await patchKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, {
        method: "PATCH",
        body: { enabled: false },
      }),
      params(),
    );
    expect(res.status).toBe(200);
  });

  it("refuses to mount a collection that has no description", async () => {
    dbMock.$enqueue(
      [row({ description: null, enabled: false })],
      [row({ description: null, enabled: false })],
    );

    const res = await patchKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, {
        method: "PATCH",
        body: { enabled: true },
      }),
      params(),
    );

    expect(res.status).toBe(400);
    expect(((await json(res)).details as Record<string, unknown>).reason).toBe(
      "DESCRIPTION_REQUIRED",
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("takes an empty description as a clear, not as a missing field", async () => {
    dbMock.$enqueue(
      [row({ enabled: false })],
      [row({ enabled: false })],
      [row({ enabled: false, description: null })],
    );

    const res = await patchKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, {
        method: "PATCH",
        body: { description: "" },
      }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(dbMock._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ description: null }),
    );
  });

  it("400s an empty patch without touching the database", async () => {
    dbMock.$enqueue([row()]);
    const res = await patchKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, { method: "PATCH", body: {} }),
      params(),
    );
    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/kb/[id]", () => {
  it("is the strict gate: 403 for a non-author editor, 204 for the author", async () => {
    getSessionMock.mockResolvedValue(createMockSession(EDITOR_USER));
    dbMock.$enqueue([row({ visibility: "public", createdBy: OWNER_ID })]);
    const denied = await deleteKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, { method: "DELETE" }),
      params(),
    );
    expect(denied.status).toBe(403);

    getSessionMock.mockResolvedValue(
      createMockSession(createMockUser({ id: OWNER_ID, role: "editor" })),
    );
    dbMock.$enqueue([row({ createdBy: OWNER_ID })]);
    const ok = await deleteKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, { method: "DELETE" }),
      params(),
    );
    expect(ok.status).toBe(204);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/kb/[id]/pages", () => {
  it("refuses an empty body, which an agent would otherwise read as a page", async () => {
    dbMock.$enqueue([row()]);
    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { path: "chapter-01/install", content: "" },
      }),
      params(),
    );
    expect(res.status).toBe(400);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses a path that nests past the folder cap", async () => {
    dbMock.$enqueue([row()]);
    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { path: "a/b/c/leaf", content: "body" },
      }),
      params(),
    );
    expect(res.status).toBe(400);
    expect(((await json(res)).message as string)).toContain("folder levels");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("stores the body verbatim, including its leading newline", async () => {
    dbMock.$enqueue([row()], [], [pageRow()]);

    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { path: "chapter-01/data", content: "\n  a,b,c\n1,2,3\n" },
      }),
      params(),
    );

    expect(res.status).toBe(201);
    const values = dbMock._chain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.path).toBe("chapter-01/data");
    expect(values.content).toBe("\n  a,b,c\n1,2,3\n");
    expect(values.size).toBe(Buffer.byteLength("\n  a,b,c\n1,2,3\n", "utf8"));
  });

  it("refuses a content type outside the text set", async () => {
    dbMock.$enqueue([row()]);
    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { path: "diagram", content: "bytes", contentType: "application/pdf" },
      }),
      params(),
    );
    expect(res.status).toBe(400);
  });

  it("reports the configured page ceiling in the refusal", async () => {
    mockConfig["kb.max_pages"] = "50";
    dbMock.$enqueue(
      [row()],
      Array.from({ length: 50 }, (_, i) => ({ id: i + 1, path: `p${i}` })),
    );

    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { path: "fifty-first", content: "body" },
      }),
      params(),
    );

    expect(res.status).toBe(400);
    expect(((await json(res)).message as string)).toContain("kb.max_pages");
  });

  it("answers a page-vs-folder collision with 409 PATH_TAKEN", async () => {
    dbMock.$enqueue([row()], [{ id: 1, path: "chapter-01" }]);

    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { path: "chapter-01/install", content: "body" },
      }),
      params(),
    );

    expect(res.status).toBe(409);
    expect(((await json(res)).details as Record<string, unknown>).reason).toBe(
      "PATH_TAKEN",
    );
  });
});

describe("GET /api/kb/[id]/pages/[...path]", () => {
  it("rejoins the catch-all segments into the stored path", async () => {
    dbMock.$enqueue([row()], [pageRow({ content: "the body" })]);

    const res = await getPageByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/chapter-01/install`),
      pathParams("chapter-01", "install"),
    );

    expect(res.status).toBe(200);
    expect(((await json(res)) as Record<string, unknown>).content).toBe("the body");
  });

  it("400s an empty path, which is the collection itself", async () => {
    dbMock.$enqueue([row()]);
    const res = await getPageByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/`),
      pathParams(),
    );
    expect(res.status).toBe(400);
    // Only the collection load ran: no page read for an unnamed address.
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /api/kb/[id]/pages/[...path]", () => {
  it("sends only the declared fields to the service", async () => {
    dbMock.$enqueue(
      [row()],
      [pageRow({ content: "old", size: 3 })],
      [pageRow({ content: "new body", size: 8 })],
    );

    const res = await patchByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/chapter-01/install`, {
        method: "PATCH",
        body: { content: "new body" },
      }),
      pathParams("chapter-01", "install"),
    );

    expect(res.status).toBe(200);
    expect(dbMock._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ content: "new body", size: 8 }),
    );
  });

  it("renames and moves through the one `newPath` field", async () => {
    dbMock.$enqueue(
      [row()],
      [pageRow()],
      [{ id: 12, path: "chapter-02/config" }],
      [pageRow({ path: "chapter-02/install" })],
    );

    const res = await patchByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/chapter-01/install`, {
        method: "PATCH",
        body: { newPath: "chapter-02/install" },
      }),
      pathParams("chapter-01", "install"),
    );

    expect(res.status).toBe(200);
    expect(dbMock._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: "chapter-02/install" }),
    );
  });

  it("refuses an undeclared field instead of ignoring it", async () => {
    dbMock.$enqueue([row()], [pageRow()]);
    const res = await patchByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/chapter-01/install`, {
        method: "PATCH",
        body: { name: "smuggled" },
      }),
      pathParams("chapter-01", "install"),
    );
    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("404s a path from another collection before writing", async () => {
    dbMock.$enqueue([row()], []);
    const res = await patchByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/nope`, {
        method: "PATCH",
        body: { content: "new body" },
      }),
      pathParams("nope"),
    );
    expect(res.status).toBe(404);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("rewrites the subtree for a folder rename and reports how many moved", async () => {
    dbMock.$enqueue(
      [row()],
      [
        { id: 1, path: "chapter-01/install" },
        { id: 2, path: "chapter-01/images/build" },
        { id: 3, path: "chapter-02/config" },
      ],
    );

    const res = await patchByPath(
      createMockRequest(
        `/api/kb/${COLLECTION_ID}/pages/chapter-01?kind=folder`,
        { method: "PATCH", body: { newPath: "appendix" } },
      ),
      pathParams("chapter-01"),
    );

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, rewritten: 2 });
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
  });

  it("400s a folder rename with an empty target instead of lifting to the root", async () => {
    dbMock.$enqueue([row()]);
    const res = await patchByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/chapter-01?kind=folder`, {
        method: "PATCH",
        body: { newPath: "" },
      }),
      pathParams("chapter-01"),
    );
    expect(res.status).toBe(400);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/kb/[id]/pages/[...path]", () => {
  it("deletes one page by path", async () => {
    dbMock.$enqueue([row()], [pageRow()]);

    const res = await deleteByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/chapter-01/install`, {
        method: "DELETE",
      }),
      pathParams("chapter-01", "install"),
    );

    expect(res.status).toBe(204);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
  });

  it("deletes a folder as its whole subtree", async () => {
    dbMock.$enqueue(
      [row()],
      [
        { id: 1, path: "chapter-01/install" },
        { id: 2, path: "chapter-01/images/build" },
        { id: 3, path: "chapter-02/config" },
      ],
    );

    const res = await deleteByPath(
      createMockRequest(
        `/api/kb/${COLLECTION_ID}/pages/chapter-01?kind=folder`,
        { method: "DELETE" },
      ),
      pathParams("chapter-01"),
    );

    expect(res.status).toBe(204);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
  });

  it("404s a folder no page carries, so a typo deletes nothing", async () => {
    dbMock.$enqueue([row()], [{ id: 1, path: "chapter-01/install" }]);

    const res = await deleteByPath(
      createMockRequest(
        `/api/kb/${COLLECTION_ID}/pages/chapter-09?kind=folder`,
        { method: "DELETE" },
      ),
      pathParams("chapter-09"),
    );

    expect(res.status).toBe(404);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("400s an empty scope instead of emptying the collection", async () => {
    dbMock.$enqueue([row()]);
    const res = await deleteByPath(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages?kind=folder`, {
        method: "DELETE",
      }),
      pathParams(),
    );
    expect(res.status).toBe(400);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});
