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
import { POST as createGroup } from "@/app/api/kb/[id]/groups/route";
import { DELETE as deleteGroup } from "@/app/api/kb/[id]/groups/[groupId]/route";
import { POST as createPage } from "@/app/api/kb/[id]/pages/route";
import {
  GET as getPage,
  PATCH as patchPage,
} from "@/app/api/kb/[id]/pages/[pageId]/route";

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

/** Handlers declare their own `params` shape, so the one-segment context is
 *  typed with `id` present rather than widened to a record. */
function params(extra?: Record<string, string>): {
  params: Promise<{ id: string } & Record<string, string>>;
} {
  return { params: Promise.resolve({ id: COLLECTION_ID, ...extra }) };
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

  it("ships the two tallies the left panel prints", async () => {
    dbMock.$enqueue(
      [row()],
      [{ collectionId: COLLECTION_ID, count: 4 }],
      [{ collectionId: COLLECTION_ID, count: 11 }],
    );

    const body = await json(await listKb(createMockRequest("/api/kb"), noParams));

    expect(Array.isArray(body)).toBe(true);
    expect(body as unknown as unknown[]).toHaveLength(1);
    const item = (body as unknown as Array<Record<string, number>>)[0];
    expect(item.topLevelGroupCount).toBe(4);
    expect(item.pageCount).toBe(11);
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
    for (const name of ["X-Manual", "1-manual", "manual with space", "a".repeat(64)]) {
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

  it("refuses the routing description below its floor", async () => {
    const res = await createKb(
      createMockRequest("/api/kb", {
        method: "POST",
        body: { name: "x-manual", description: "too short" },
      }),
      noParams,
    );
    expect(res.status).toBe(400);
    expect(dbMock.insert).not.toHaveBeenCalled();
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

  it("returns the tree without page bodies", async () => {
    dbMock.$enqueue(
      [row()],
      [{ id: 1, collectionId: COLLECTION_ID, parentId: null, name: "chapter-10", description: "Ten." }],
      [
        { id: 11, name: "chapter-2", groupId: null, size: 11 },
        { id: 12, name: "chapter-10", groupId: 1, size: 12 },
      ],
    );

    const body = (await json(
      await getKb(createMockRequest(`/api/kb/${COLLECTION_ID}`), params()),
    )) as Record<string, Array<{ name: string }>>;

    expect(body.pages.map((p) => p.name)).toEqual(["chapter-2", "chapter-10"]);
    expect(body.groups.map((g) => g.name)).toEqual(["chapter-10"]);
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
    dbMock.$enqueue([row({ visibility: "public", createdBy: OWNER_ID })]);

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
    dbMock.$enqueue([row({ createdBy: OWNER_ID })], [row({ enabled: false })]);

    const res = await patchKb(
      createMockRequest(`/api/kb/${COLLECTION_ID}`, {
        method: "PATCH",
        body: { enabled: false },
      }),
      params(),
    );
    expect(res.status).toBe(200);
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

describe("POST /api/kb/[id]/groups", () => {
  it("requires the group description that the injected block renders", async () => {
    dbMock.$enqueue([row()]);
    const res = await createGroup(
      createMockRequest(`/api/kb/${COLLECTION_ID}/groups`, {
        method: "POST",
        body: { name: "chapter-01", description: "short" },
      }),
      params(),
    );
    expect(res.status).toBe(400);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("creates at level 1 when no parent is given", async () => {
    dbMock.$enqueue([row()], [{ count: 0 }], [{ id: 1, name: "chapter-01" }]);

    const res = await createGroup(
      createMockRequest(`/api/kb/${COLLECTION_ID}/groups`, {
        method: "POST",
        body: { name: "chapter-01", description: "Install and operations." },
      }),
      params(),
    );

    expect(res.status).toBe(201);
    expect(dbMock._chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: null }),
    );
  });
});

describe("POST /api/kb/[id]/pages", () => {
  it("refuses an empty body, which an agent would otherwise read as a page", async () => {
    dbMock.$enqueue([row()]);
    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { name: "install", content: "" },
      }),
      params(),
    );
    expect(res.status).toBe(400);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("stores the body verbatim, including its leading newline", async () => {
    dbMock.$enqueue([row()], [{ count: 0 }], [{ id: 11, name: "install" }]);

    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { name: "install", content: "\n  a,b,c\n1,2,3\n" },
      }),
      params(),
    );

    expect(res.status).toBe(201);
    const values = dbMock._chain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.content).toBe("\n  a,b,c\n1,2,3\n");
    expect(values.size).toBe(Buffer.byteLength("\n  a,b,c\n1,2,3\n", "utf8"));
  });

  it("refuses a content type outside the text set", async () => {
    dbMock.$enqueue([row()]);
    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { name: "diagram", content: "bytes", contentType: "application/pdf" },
      }),
      params(),
    );
    expect(res.status).toBe(400);
  });

  it("reports the configured page ceiling in the refusal", async () => {
    mockConfig["kb.max_pages"] = "50";
    dbMock.$enqueue([row()], [{ count: 50 }]);

    const res = await createPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages`, {
        method: "POST",
        body: { name: "fifty-first", content: "body" },
      }),
      params(),
    );

    expect(res.status).toBe(400);
    expect(((await json(res)).message as string)).toContain("kb.max_pages");
  });
});

describe("GET /api/kb/[id]/pages/[pageId]", () => {
  it("400s a non-integer row id", async () => {
    dbMock.$enqueue([row()]);
    const res = await getPage(createMockRequest(`/api/kb/${COLLECTION_ID}/pages/abc`), {
      params: Promise.resolve({ id: COLLECTION_ID, pageId: "abc" }),
    });
    expect(res.status).toBe(400);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it("is the only read that returns the body", async () => {
    dbMock.$enqueue([row()], [{ id: 11, name: "install", content: "the body" }]);

    const res = await getPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/11`),
      { params: Promise.resolve({ id: COLLECTION_ID, pageId: "11" }) },
    );

    expect(((await json(res)) as Record<string, unknown>).content).toBe("the body");
  });
});

describe("PATCH /api/kb/[id]/pages/[pageId]", () => {
  it("sends only the declared fields to the service", async () => {
    dbMock.$enqueue(
      [row()],
      [{ id: 11, name: "install", content: "old", size: 3 }],
      [{ id: 11, name: "install", content: "new body", size: 8 }],
    );

    const res = await patchPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/11`, {
        method: "PATCH",
        body: { content: "new body" },
      }),
      { params: Promise.resolve({ id: COLLECTION_ID, pageId: "11" }) },
    );

    expect(res.status).toBe(200);
    expect(dbMock._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ content: "new body", size: 8 }),
    );
  });

  it("404s a page id from another collection before writing", async () => {
    dbMock.$enqueue([row()], []);
    const res = await patchPage(
      createMockRequest(`/api/kb/${COLLECTION_ID}/pages/11`, {
        method: "PATCH",
        body: { content: "new body" },
      }),
      { params: Promise.resolve({ id: COLLECTION_ID, pageId: "11" }) },
    );
    expect(res.status).toBe(404);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/kb/[id]/groups/[groupId]", () => {
  it("deletes a leaf group and its pages", async () => {
    dbMock.$enqueue(
      [row()],
      [{ id: 1, collectionId: COLLECTION_ID, parentId: null, name: "chapter-01" }],
      [{ count: 0 }],
    );

    const res = await deleteGroup(
      createMockRequest(`/api/kb/${COLLECTION_ID}/groups/1`, { method: "DELETE" }),
      { params: Promise.resolve({ id: COLLECTION_ID, groupId: "1" }) },
    );

    expect(res.status).toBe(204);
    expect(dbMock.delete).toHaveBeenCalledTimes(2);
  });

  it("surfaces 409 GROUP_HAS_CHILDREN instead of promoting the subtree", async () => {
    dbMock.$enqueue(
      [row()],
      [{ id: 1, collectionId: COLLECTION_ID, parentId: null, name: "chapter-01" }],
      [{ count: 2 }],
    );

    const res = await deleteGroup(
      createMockRequest(`/api/kb/${COLLECTION_ID}/groups/1`, { method: "DELETE" }),
      { params: Promise.resolve({ id: COLLECTION_ID, groupId: "1" }) },
    );

    expect(res.status).toBe(409);
    expect(((await json(res)).message as string)).toContain("nested group");
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});
