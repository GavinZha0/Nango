import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { ArtifactTable, type ArtifactEntity } from "@/lib/db/schema";
import {
  type ArtifactKind,
  SEED_CATEGORIES,
} from "@/lib/domain/artifact";
import { ApiError } from "@/lib/http/route-handlers";

/**
 * Domain service for the per-user artifact tree.
 *
 * One row in `artifact` = one node. Self-FK `parent_id` builds the
 * tree. `kind` discriminates organisational folders from leaf
 * artifacts. Top-level rows (`parent_id IS NULL`) are system-seeded
 * categories and are immutable to the user. All write paths go
 * through this service so the tree invariants stay enforced.
 *
 * See docs/artifact-dashboard-migration.md.
 */

// ───────────────────────────── Types ─────────────────────────────

/**
 * Tree shape returned by {@link assembleTree}. Children are populated
 * recursively; leaves have an empty `children` array.
 */
export type ArtifactNode = ArtifactEntity & {
  children: ArtifactNode[];
};

export interface CreateFolderInput {
  ownerId: string;
  name: string;
  /** Required — top-level seed categories are not user-creatable. */
  parentId: string;
  description?: string | null;
}

export interface UpdateNodeInput {
  name?: string;
  description?: string | null;
  parentId?: string | null;
  displayOrder?: number;
  visibility?: "private" | "shared";
  /** Switch between snapshot and live data modes. */
  viewMode?: "snapshot" | "live";
}

// ──────────────────────────── Seeding ────────────────────────────

/**
 * Insert one folder row per `SEED_CATEGORIES` entry for the given
 * user. Idempotent: skips entries already present at the root.
 *
 * Called from the better-auth `databaseHooks.user.create.after`
 * hook so every freshly registered user has a non-empty tree on
 * first login.
 */
export async function seedArtifactCategoriesForUser(
  ownerId: string,
): Promise<void> {
  const existing: { name: string }[] = await db
    .select({ name: ArtifactTable.name })
    .from(ArtifactTable)
    .where(
      and(eq(ArtifactTable.createdBy, ownerId), isNull(ArtifactTable.parentId)),
    );
  const present: Set<string> = new Set(existing.map((row) => row.name));

  const toInsert = SEED_CATEGORIES.filter((cat) => !present.has(cat.name)).map(
    (cat, idx) => ({
      ownerId,
      kind: "folder" as const satisfies ArtifactKind,
      parentId: null,
      name: cat.name,
      displayOrder: idx,
    }),
  );
  if (toInsert.length === 0) return;

  await db.insert(ArtifactTable).values(
    toInsert.map((row) => ({
      kind: row.kind,
      parentId: row.parentId,
      name: row.name,
      displayOrder: row.displayOrder,
      createdBy: row.ownerId,
    })),
  );
}

// ────────────────────────── Invariants ───────────────────────────

/** Top-level seed categories cannot be renamed / moved / deleted. */
function assertNotSeedCategory(row: ArtifactEntity): void {
  if (row.parentId === null && row.kind === "folder") {
    throw new ApiError(
      "FORBIDDEN",
      403,
      "System categories cannot be modified or deleted",
    );
  }
}

/**
 * Verify that {@link parentId} resolves to a folder owned by the same
 * user. Returns the parent row.
 */
async function loadOwnedFolder(
  parentId: string,
  ownerId: string,
): Promise<ArtifactEntity> {
  const [parent] = await db
    .select()
    .from(ArtifactTable)
    .where(
      and(eq(ArtifactTable.id, parentId), eq(ArtifactTable.createdBy, ownerId)),
    )
    .limit(1);
  if (!parent) {
    throw new ApiError("NOT_FOUND", 404, "Parent folder not found");
  }
  if (parent.kind !== "folder") {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "Parent must be a folder, not an artifact",
    );
  }
  return parent;
}

// ──────────────────────────── Reads ──────────────────────────────

/**
 * Fetch every artifact row owned by `ownerId` and assemble them into
 * a nested tree. Sibling order: `displayOrder ASC, createdAt ASC`.
 */
export async function assembleTree(ownerId: string): Promise<ArtifactNode[]> {
  const rows: ArtifactEntity[] = await db
    .select()
    .from(ArtifactTable)
    .where(eq(ArtifactTable.createdBy, ownerId))
    .orderBy(asc(ArtifactTable.displayOrder), asc(ArtifactTable.createdAt));

  const byId: Map<string, ArtifactNode> = new Map(
    rows.map((row) => [row.id, { ...row, children: [] }]),
  );
  const roots: ArtifactNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (parent) parent.children.push(node);
    // Dangling parent_id (parent owned by different user — should be
    // impossible) is silently dropped; surface only legit roots.
  }
  return roots;
}

/**
 * Fetch a single row, asserting ownership. Throws 404 on miss.
 */
export async function getNode(
  id: string,
  ownerId: string,
): Promise<ArtifactEntity> {
  const [row] = await db
    .select()
    .from(ArtifactTable)
    .where(and(eq(ArtifactTable.id, id), eq(ArtifactTable.createdBy, ownerId)))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", 404, "Artifact not found");
  return row;
}

// ──────────────────────────── Writes ─────────────────────────────

/**
 * Persist a user-created sub-folder. Top-level folders cannot be
 * created via this path — `parentId` is required.
 */
export async function createFolder(
  input: CreateFolderInput,
): Promise<ArtifactEntity> {
  await loadOwnedFolder(input.parentId, input.ownerId);

  const [row] = await db
    .insert(ArtifactTable)
    .values({
      kind: "folder",
      parentId: input.parentId,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.ownerId,
    })
    .returning();
  return row;
}

/**
 * Apply a partial update. Rejects edits to top-level seed categories
 * and rejects moves that would create a cycle.
 */
export async function updateNode(
  id: string,
  patch: UpdateNodeInput,
  ownerId: string,
): Promise<ArtifactEntity> {
  const current: ArtifactEntity = await getNode(id, ownerId);
  assertNotSeedCategory(current);

  if (patch.parentId !== undefined) {
    if (patch.parentId === null) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Only system categories may live at the root",
      );
    }
    if (patch.parentId === id) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "A node cannot be its own parent",
      );
    }
    await loadOwnedFolder(patch.parentId, ownerId);
    if (current.kind === "folder") {
      await assertNoCycle(id, patch.parentId, ownerId);
    }
  }

  const [row] = await db
    .update(ArtifactTable)
    .set({
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      parentId: patch.parentId ?? current.parentId,
      displayOrder: patch.displayOrder ?? current.displayOrder,
      visibility: patch.visibility ?? current.visibility,
      ...(patch.viewMode !== undefined && { viewMode: patch.viewMode }),
      updatedAt: new Date(),
    })
    .where(eq(ArtifactTable.id, id))
    .returning();
  return row;
}

/**
 * Walk up from `proposedParentId` to ensure it is not a descendant
 * of `nodeId` — moving a folder under its own subtree would create
 * an orphaned cycle the tree walker cannot recover from.
 */
async function assertNoCycle(
  nodeId: string,
  proposedParentId: string,
  ownerId: string,
): Promise<void> {
  let cursor: string | null = proposedParentId;
  // Bounded iteration: real trees are shallow; this guard is just
  // defence-in-depth against a malformed DB.
  for (let hops = 0; hops < 64 && cursor !== null; hops += 1) {
    if (cursor === nodeId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Cannot move a folder under its own descendant",
      );
    }
    const [parent] = await db
      .select({ parentId: ArtifactTable.parentId })
      .from(ArtifactTable)
      .where(
        and(
          eq(ArtifactTable.id, cursor),
          eq(ArtifactTable.createdBy, ownerId),
        ),
      )
      .limit(1);
    cursor = parent?.parentId ?? null;
  }
}

/**
 * Delete a node. Refuses to delete seed categories. Refuses to
 * delete a non-empty folder — caller must clear children first.
 */
export async function deleteNode(id: string, ownerId: string): Promise<void> {
  const current: ArtifactEntity = await getNode(id, ownerId);
  assertNotSeedCategory(current);

  if (current.kind === "folder") {
    const [child] = await db
      .select({ id: ArtifactTable.id })
      .from(ArtifactTable)
      .where(eq(ArtifactTable.parentId, id))
      .limit(1);
    if (child) {
      throw new ApiError(
        "CONFLICT",
        409,
        "Folder is not empty",
      );
    }
  }

  await db.delete(ArtifactTable).where(eq(ArtifactTable.id, id));
}
