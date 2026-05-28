/**
 * Unit tests for the artifact service layer.
 *
 * Strategy: mock `@/lib/db` so each call returns canned rows; assert
 * the service's invariants and tree-assembly logic without touching
 * a real Postgres. End-to-end coverage of the wire shape and the
 * Postgres-side migration was performed via the §10 smoke ledger in
 * `docs/artifact-dashboard-migration.md`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Sequenced query queue: each chained call (`db.select().from().where()...`)
// shifts the next pre-canned result. Tests push the rows they expect
// the service to consume in order.
const queue: unknown[] = [];

function enqueue(rows: unknown[]): void {
  queue.push(rows);
}

function pop(): unknown[] {
  if (queue.length === 0) {
    throw new Error("[test] DB queue exhausted — service issued an unexpected query");
  }
  return queue.shift() as unknown[];
}

// Drizzle's fluent builder returns chainable proxies. We give every
// terminal method (`limit`, `orderBy`, the bare `where` for the
// no-limit seed query, and `.returning()`) the same `pop()` so
// callers don't have to script per-method order.
function buildSelectChain(): unknown {
  const terminal = (): Promise<unknown[]> => Promise.resolve(pop());
  const where = vi.fn(() => ({
    limit: vi.fn(terminal),
    orderBy: vi.fn(terminal),
    then: (resolve: (v: unknown) => unknown): unknown => resolve(pop()),
  }));
  return {
    from: vi.fn(() => ({
      where,
      orderBy: vi.fn(terminal),
      limit: vi.fn(terminal),
    })),
  };
}

const insertedValues: unknown[] = [];
const updatedValues: unknown[] = [];
const deletedWhereCalls: number[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => buildSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn((vals: unknown) => {
        insertedValues.push(vals);
        return {
          returning: vi.fn(async () => {
            // For `returning()`, hand back what the caller would
            // typically expect — the row(s) they inserted with an
            // `id` filled in. Tests can override by enqueueing.
            const next: unknown[] | undefined = queue.shift() as
              | unknown[]
              | undefined;
            if (next) return next;
            // Fallback: synthesise an id and echo the input.
            const arr: unknown[] = Array.isArray(vals) ? vals : [vals];
            return arr.map((v, i) => ({ id: `gen-${i}`, ...(v as object) }));
          }),
          // Bare insert (no .returning()) — seed path uses this.
          then: (resolve: (v: unknown) => unknown): unknown => resolve(undefined),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: unknown) => {
        updatedValues.push(vals);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              const next: unknown[] | undefined = queue.shift() as
                | unknown[]
                | undefined;
              return next ?? [{ id: "stub", ...(vals as object) }];
            }),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        deletedWhereCalls.push(Date.now());
      }),
    })),
  },
}));

vi.mock("@/lib/http/route-handlers", () => ({
  // Bare-bones ApiError so service can throw without dragging in
  // the full Next.js / better-auth import chain.
  ApiError: class ApiError extends Error {
    public readonly code: string;
    public readonly status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock("@/lib/db/schema", () => ({
  ArtifactTable: {
    id: "id",
    parentId: "parent_id",
    kind: "kind",
    type: "type",
    name: "name",
    description: "description",
    content: "content",
    config: "config",
    visibility: "visibility",
    displayOrder: "display_order",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
    sourceThreadId: "source_thread_id",
    sourceOutcomeId: "source_outcome_id",
  },
}));

const {
  assembleTree,
  createFolder,
  deleteNode,
  seedArtifactCategoriesForUser,
  updateNode,
} = await import("@/lib/artifacts/service");
const { db } = await import("@/lib/db");

const OWNER = "user-1";

// Minimal artifact row shape (only fields the service reads).
function row(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "x",
    parentId: null,
    kind: "artifact",
    type: null,
    name: "x",
    description: null,
    content: null,
    config: null,
    visibility: "private",
    displayOrder: 0,
    createdBy: OWNER,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    sourceThreadId: null,
    sourceOutcomeId: null,
    ...overrides,
  };
}

beforeEach(() => {
  queue.length = 0;
  insertedValues.length = 0;
  updatedValues.length = 0;
  deletedWhereCalls.length = 0;
  vi.clearAllMocks();
});

// ─────────────────────────── assembleTree ───────────────────────────

describe("assembleTree", () => {
  it("returns empty array on empty input", async () => {
    enqueue([]);
    const tree = await assembleTree(OWNER);
    expect(tree).toEqual([]);
  });

  it("nests leaves under their root folders", async () => {
    enqueue([
      row({ id: "root-charts", kind: "folder", name: "Charts" }),
      row({ id: "root-reports", kind: "folder", name: "Reports" }),
      row({
        id: "leaf-1",
        parentId: "root-charts",
        kind: "artifact",
        type: "chart",
        name: "C1",
      }),
      row({
        id: "leaf-2",
        parentId: "root-charts",
        kind: "artifact",
        type: "chart",
        name: "C2",
      }),
      row({
        id: "leaf-3",
        parentId: "root-reports",
        kind: "artifact",
        type: "report",
        name: "R1",
      }),
    ]);
    const tree = await assembleTree(OWNER);
    expect(tree).toHaveLength(2);
    expect(tree[0].name).toBe("Charts");
    expect(tree[0].children.map((c) => c.name)).toEqual(["C1", "C2"]);
    expect(tree[1].name).toBe("Reports");
    expect(tree[1].children).toHaveLength(1);
  });

  it("supports multi-level nesting", async () => {
    enqueue([
      row({ id: "root", kind: "folder", name: "Charts" }),
      row({
        id: "sub",
        parentId: "root",
        kind: "folder",
        name: "Q4",
      }),
      row({
        id: "leaf",
        parentId: "sub",
        kind: "artifact",
        type: "chart",
        name: "revenue",
      }),
    ]);
    const tree = await assembleTree(OWNER);
    expect(tree[0].children[0].children[0].name).toBe("revenue");
  });

  it("drops nodes whose parent is missing", async () => {
    enqueue([
      row({
        id: "orphan",
        parentId: "ghost",
        kind: "artifact",
        type: "chart",
        name: "lonely",
      }),
    ]);
    const tree = await assembleTree(OWNER);
    expect(tree).toEqual([]);
  });
});

// ──────────────────── seedArtifactCategoriesForUser ─────────────────

describe("seedArtifactCategoriesForUser", () => {
  it("inserts all 6 categories when none exist", async () => {
    enqueue([]); // existing root rows = none
    await seedArtifactCategoriesForUser(OWNER);
    expect(db.insert).toHaveBeenCalledOnce();
    const inserted = insertedValues[0] as Array<{ name: string; kind: string }>;
    expect(inserted.map((r) => r.name).sort()).toEqual(
      ["Charts", "Code", "HTML", "Images", "PPT", "Reports"].sort(),
    );
    expect(inserted.every((r) => r.kind === "folder")).toBe(true);
  });

  it("skips categories that already exist", async () => {
    enqueue([{ name: "Charts" }, { name: "Reports" }]);
    await seedArtifactCategoriesForUser(OWNER);
    const inserted = insertedValues[0] as Array<{ name: string }>;
    expect(inserted.map((r) => r.name).sort()).toEqual(
      ["Code", "HTML", "Images", "PPT"].sort(),
    );
  });

  it("no-ops when all categories present", async () => {
    enqueue([
      { name: "Charts" },
      { name: "Reports" },
      { name: "Code" },
      { name: "Images" },
      { name: "HTML" },
      { name: "PPT" },
    ]);
    await seedArtifactCategoriesForUser(OWNER);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── updateNode ────────────────────────────

describe("updateNode", () => {
  it("rejects edits to top-level seed categories", async () => {
    enqueue([row({ id: "cat", parentId: null, kind: "folder", name: "Charts" })]);
    await expect(updateNode("cat", { name: "Renamed" }, OWNER)).rejects.toThrow(
      /System categories/,
    );
  });

  it("rejects self-as-parent", async () => {
    enqueue([row({ id: "f", parentId: "p1", kind: "folder", name: "f" })]);
    await expect(
      updateNode("f", { parentId: "f" }, OWNER),
    ).rejects.toThrow(/own parent/);
  });

  it("rejects reparent to root", async () => {
    enqueue([row({ id: "f", parentId: "p1", kind: "folder", name: "f" })]);
    await expect(
      updateNode("f", { parentId: null }, OWNER),
    ).rejects.toThrow(/system categories/i);
  });

  it("rejects move under own descendant (cycle)", async () => {
    // getNode → current
    enqueue([row({ id: "A", parentId: "root", kind: "folder", name: "A" })]);
    // loadOwnedFolder(target=B) → returns B as folder owned by user
    enqueue([row({ id: "B", parentId: "A", kind: "folder", name: "B" })]);
    // assertNoCycle walks B → parent A → matches nodeId, throws
    enqueue([{ parentId: "A" }]);
    await expect(
      updateNode("A", { parentId: "B" }, OWNER),
    ).rejects.toThrow(/descendant/);
  });

  it("renames a leaf successfully", async () => {
    // getNode
    enqueue([row({ id: "leaf", parentId: "charts", kind: "artifact", type: "chart", name: "old" })]);
    // update returning
    enqueue([row({ id: "leaf", parentId: "charts", kind: "artifact", type: "chart", name: "new" })]);
    const updated = await updateNode("leaf", { name: "new" }, OWNER);
    expect(updated.name).toBe("new");
    expect(updatedValues).toHaveLength(1);
  });
});

// ─────────────────────────── deleteNode ────────────────────────────

describe("deleteNode", () => {
  it("rejects deletion of seed category", async () => {
    enqueue([row({ id: "cat", parentId: null, kind: "folder", name: "Charts" })]);
    await expect(deleteNode("cat", OWNER)).rejects.toThrow(/System categories/);
  });

  it("rejects deletion of non-empty folder", async () => {
    // getNode → folder under a parent
    enqueue([row({ id: "f", parentId: "charts", kind: "folder", name: "f" })]);
    // child check → at least one row
    enqueue([{ id: "child-1" }]);
    await expect(deleteNode("f", OWNER)).rejects.toThrow(/not empty/);
  });

  it("deletes an empty folder", async () => {
    enqueue([row({ id: "f", parentId: "charts", kind: "folder", name: "f" })]);
    enqueue([]); // no children
    await deleteNode("f", OWNER);
    expect(deletedWhereCalls).toHaveLength(1);
  });

  it("deletes a leaf without child-check", async () => {
    enqueue([row({ id: "leaf", parentId: "charts", kind: "artifact", type: "chart", name: "x" })]);
    await deleteNode("leaf", OWNER);
    expect(deletedWhereCalls).toHaveLength(1);
  });
});

// ────────────────────────── createFolder ──────────────────────────

describe("createFolder", () => {
  it("rejects when parent is missing", async () => {
    enqueue([]); // loadOwnedFolder finds nothing
    await expect(
      createFolder({ ownerId: OWNER, name: "x", parentId: "ghost" }),
    ).rejects.toThrow(/Parent folder not found/);
  });

  it("rejects when parent is a leaf, not a folder", async () => {
    enqueue([row({ id: "leaf", parentId: "charts", kind: "artifact", type: "chart", name: "leaf" })]);
    await expect(
      createFolder({ ownerId: OWNER, name: "x", parentId: "leaf" }),
    ).rejects.toThrow(/must be a folder/);
  });

  it("inserts under a valid parent folder", async () => {
    enqueue([row({ id: "parent", parentId: "root", kind: "folder", name: "parent" })]);
    // insert returning auto-fills
    const created = await createFolder({
      ownerId: OWNER,
      name: "new-folder",
      parentId: "parent",
    });
    expect(created.name).toBe("new-folder");
    expect(insertedValues[0]).toMatchObject({ kind: "folder", parentId: "parent" });
  });
});


