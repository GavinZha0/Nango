/**
 * Domain service for the knowledge base: three levels (collection → group →
 * page), all structural invariants, all config-backed budgets.
 *
 * Every write path goes through here so the tree rules cannot be bypassed.
 * See docs/kb.md.
 */

import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  KbCollectionTable,
  KbGroupTable,
  KbPageTable,
  type KbCollectionEntity,
  type KbContentType,
  type KbGroupEntity,
  type KbPageEntity,
} from "@/lib/db/schema";
import { visibilitySql } from "@/lib/auth/permissions";
import { ApiError, type Session } from "@/lib/http/route-handlers";
import { isUniqueViolation } from "@/lib/http/validation";
import { alphabeticCompare } from "@/lib/utils/sort";
import {
  MAX_GROUPS_PER_COLLECTION,
  MAX_PAGES_PER_COLLECTION,
  PAGE_MAX_BYTES,
} from "@/lib/kb/budgets";
import { MAX_GROUP_DEPTH } from "@/lib/kb/limits";

/** Columns a list/tree read returns for a page — `content` stays behind. */
export type KbPageSummary = Omit<KbPageEntity, "content">;

export interface KbTree {
  groups: KbGroupEntity[];
  pages: KbPageSummary[];
}

export interface CollectionListItem extends KbCollectionEntity {
  /** Level-1 groups only: the panel prints this, or `pageCount` when it is 0. */
  topLevelGroupCount: number;
  pageCount: number;
}

export interface CreateCollectionInput {
  name: string;
  description: string;
  visibility?: "private" | "public";
  createdBy: string;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  visibility?: "private" | "public";
}

export interface CreateGroupInput {
  name: string;
  description: string;
  parentId?: number | null;
}

export interface UpdateGroupInput {
  name?: string;
  description?: string;
  /** Move. `null` moves the group to level 1. */
  parentId?: number | null;
}

export interface CreatePageInput {
  name: string;
  description?: string | null;
  groupId?: number | null;
  content: string;
  contentType?: KbContentType;
  sourceRef?: string | null;
}

export interface UpdatePageInput {
  name?: string;
  description?: string | null;
  /** Move between groups. `null` puts the page at the collection root. */
  groupId?: number | null;
  content?: string;
  contentType?: KbContentType;
  sourceRef?: string | null;
}

// ──────────────────────────── Reads ──────────────────────────────

/** Collections visible to the session, each with its top-level and page tallies. */
export async function listCollections(
  session: Session,
): Promise<CollectionListItem[]> {
  const rows: KbCollectionEntity[] = await db
    .select()
    .from(KbCollectionTable)
    .where(
      visibilitySql(
        session,
        KbCollectionTable.visibility,
        KbCollectionTable.createdBy,
      ),
    )
    .orderBy(desc(KbCollectionTable.createdAt));

  if (rows.length === 0) return [];

  const ids: string[] = rows.map((row) => row.id);
  const [groupCounts, pageCounts] = await Promise.all([
    countTopLevelGroupsByCollection(ids),
    countPagesByCollection(ids),
  ]);

  return rows.map((row) => ({
    ...row,
    topLevelGroupCount: groupCounts.get(row.id) ?? 0,
    pageCount: pageCounts.get(row.id) ?? 0,
  }));
}

/**
 * Level-1 groups per collection — the top level the editor tree opens on, not
 * every group at any depth, so the panel's number and the header's are the same
 * number.
 */
async function countTopLevelGroupsByCollection(
  ids: string[],
): Promise<Map<string, number>> {
  const rows: Array<{ collectionId: string; count: number }> = await db
    .select({
      collectionId: KbGroupTable.collectionId,
      count: sql<number>`count(*)::int`,
    })
    .from(KbGroupTable)
    .where(
      and(
        inArray(KbGroupTable.collectionId, ids),
        isNull(KbGroupTable.parentId),
      ),
    )
    .groupBy(KbGroupTable.collectionId);
  return new Map(rows.map((row) => [row.collectionId, row.count]));
}

async function countPagesByCollection(
  ids: string[],
): Promise<Map<string, number>> {
  const rows: Array<{ collectionId: string; count: number }> = await db
    .select({
      collectionId: KbPageTable.collectionId,
      count: sql<number>`count(*)::int`,
    })
    .from(KbPageTable)
    .where(inArray(KbPageTable.collectionId, ids))
    .groupBy(KbPageTable.collectionId);
  return new Map(rows.map((row) => [row.collectionId, row.count]));
}

/**
 * The whole tree, minus page bodies.
 *
 * CONTRACT: sorted here with `alphabeticCompare`, once, so the editor tree and
 * the agent-facing index cannot drift. Postgres orders bytes without `COLLATE`,
 * which puts `chapter-10` before `chapter-2`.
 */
export async function getTree(collectionId: string): Promise<KbTree> {
  const [groups, pages] = await Promise.all([
    db
      .select()
      .from(KbGroupTable)
      .where(eq(KbGroupTable.collectionId, collectionId))
      .orderBy(asc(KbGroupTable.name)),
    db
      .select({
        id: KbPageTable.id,
        collectionId: KbPageTable.collectionId,
        groupId: KbPageTable.groupId,
        name: KbPageTable.name,
        description: KbPageTable.description,
        contentType: KbPageTable.contentType,
        size: KbPageTable.size,
        sourceRef: KbPageTable.sourceRef,
        createdBy: KbPageTable.createdBy,
        updatedBy: KbPageTable.updatedBy,
        createdAt: KbPageTable.createdAt,
        updatedAt: KbPageTable.updatedAt,
      })
      .from(KbPageTable)
      .where(eq(KbPageTable.collectionId, collectionId))
      .orderBy(asc(KbPageTable.name)),
  ]);

  return {
    groups: [...groups].sort((a, b) => alphabeticCompare(a.name, b.name)),
    pages: [...pages].sort((a, b) => alphabeticCompare(a.name, b.name)),
  };
}

/** One page with its body — the only read that returns `content`. */
export async function getPage(
  collectionId: string,
  pageId: number,
): Promise<KbPageEntity> {
  const [row] = await db
    .select()
    .from(KbPageTable)
    .where(
      and(eq(KbPageTable.id, pageId), eq(KbPageTable.collectionId, collectionId)),
    )
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", 404, "Page not found.");
  return row;
}

// ──────────────────────── Collection writes ──────────────────────

export async function createCollection(
  input: CreateCollectionInput,
): Promise<KbCollectionEntity> {
  assertValidText("Collection name", input.name);
  assertValidText("Collection description", input.description);
  try {
    const [row] = await db
      .insert(KbCollectionTable)
      .values({
        name: input.name,
        description: input.description,
        visibility: input.visibility ?? "private",
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
      })
      .returning();
    return row;
  } catch (err) {
    throwIfNameTaken(err, input.name);
    throw err;
  }
}

export async function updateCollection(
  collectionId: string,
  patch: UpdateCollectionInput,
  actorId: string,
): Promise<KbCollectionEntity> {
  if (Object.keys(patch).length === 0) {
    throw new ApiError("BAD_REQUEST", 400, "No fields to update.");
  }
  if (patch.name !== undefined) assertValidText("Collection name", patch.name);
  if (patch.description !== undefined) {
    assertValidText("Collection description", patch.description);
  }
  try {
    const [row] = await db
      .update(KbCollectionTable)
      .set({ ...patch, updatedBy: actorId, updatedAt: new Date() })
      .where(eq(KbCollectionTable.id, collectionId))
      .returning();
    if (!row) {
      throw new ApiError("NOT_FOUND", 404, "Knowledge collection not found.");
    }
    return row;
  } catch (err) {
    if (patch.name !== undefined) throwIfNameTaken(err, patch.name);
    throw err;
  }
}

/**
 * Hard delete. `kb_group` / `kb_page` cascade and `builtin_agent_tool`
 * releases its binding; ownership columns are SET NULL so no user purge ever
 * reaches this path.
 */
export async function deleteCollection(collectionId: string): Promise<void> {
  await db
    .delete(KbCollectionTable)
    .where(eq(KbCollectionTable.id, collectionId));
}

// ────────────────────────── Group writes ─────────────────────────

/** `kb_group` has no audit columns, so a group write carries no actor. */
export async function createGroup(
  collectionId: string,
  input: CreateGroupInput,
): Promise<KbGroupEntity> {
  assertValidText("Group name", input.name);
  assertValidText("Group description", input.description);
  if (input.parentId != null) {
    await requireLevelOneParent(collectionId, input.parentId);
  }
  await assertGroupLimit(collectionId);

  try {
    const [row] = await db
      .insert(KbGroupTable)
      .values({
        collectionId,
        parentId: input.parentId ?? null,
        name: input.name,
        description: input.description,
      })
      .returning();
    return row;
  } catch (err) {
    throwIfNameTaken(err, input.name);
    throw err;
  }
}

export async function updateGroup(
  collectionId: string,
  groupId: number,
  patch: UpdateGroupInput,
): Promise<KbGroupEntity> {
  const current: KbGroupEntity = await loadGroup(collectionId, groupId);
  if (Object.keys(patch).length === 0) {
    throw new ApiError("BAD_REQUEST", 400, "No fields to update.");
  }
  if (patch.name !== undefined) assertValidText("Group name", patch.name);
  if (patch.description !== undefined) {
    assertValidText("Group description", patch.description);
  }

  if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
    await assertMoveLegal(collectionId, current, patch.parentId);
  }

  try {
    const [row] = await db
      .update(KbGroupTable)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      })
      .where(eq(KbGroupTable.id, groupId))
      .returning();
    return row;
  } catch (err) {
    if (patch.name !== undefined) throwIfNameTaken(err, patch.name);
    throw err;
  }
}

/**
 * Delete a group **and every page under it**. Pages are content: a directory is
 * removed by removing what it holds, so nothing survives silently.
 *
 * A group that still has child groups is refused, because `parent_id` is
 * RESTRICT and silently promoting them would rewrite the author's structure.
 * That refusal is also what makes the page delete complete: with child groups
 * ruled out, the rows carrying this `group_id` are the whole subtree, so no
 * grandchild page can be left pointing at a vanished group.
 *
 * `kb_page.group_id` stays `ON DELETE SET NULL` in the schema — the DB keeps the
 * conservative behaviour for a hand-run `DELETE`, and this function is the only
 * path that turns "delete the group" into "delete its pages".
 */
export async function deleteGroup(
  collectionId: string,
  groupId: number,
): Promise<void> {
  await loadGroup(collectionId, groupId);

  const childCount: number = await countGroupsByParent(groupId);
  if (childCount > 0) {
    throw new ApiError(
      "CONFLICT",
      409,
      `This group has ${childCount} nested group(s). Delete or move them first.`,
      { reason: "GROUP_HAS_CHILDREN", childGroupCount: childCount },
    );
  }

  await db.transaction(async (tx) => {
    // `collection_id` is implied by the group's own collection but stated
    // anyway: it is the leading column of the composite index, so the delete
    // stays an index scan instead of a full read of `kb_page`.
    await tx.delete(KbPageTable).where(
      and(
        eq(KbPageTable.collectionId, collectionId),
        eq(KbPageTable.groupId, groupId),
      ),
    );
    await tx.delete(KbGroupTable).where(eq(KbGroupTable.id, groupId));
  });
}

// ─────────────────────────── Page writes ─────────────────────────

export async function createPage(
  collectionId: string,
  input: CreatePageInput,
  actorId: string,
): Promise<KbPageEntity> {
  assertValidText("Page name", input.name);
  if (input.description != null) {
    assertValidText("Page description", input.description);
  }
  if (input.groupId != null) {
    await requirePayloadGroup(collectionId, input.groupId);
  }
  await assertPageLimit(collectionId);
  const size: number = assertContentFits(input.content);
  assertValidText("Page content", input.content);

  try {
    const [row] = await db
      .insert(KbPageTable)
      .values({
        collectionId,
        groupId: input.groupId ?? null,
        name: input.name,
        description: input.description ?? null,
        content: input.content,
        contentType: input.contentType ?? "text/markdown",
        size,
        sourceRef: input.sourceRef ?? null,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    return row;
  } catch (err) {
    throwIfNameTaken(err, input.name);
    throw err;
  }
}

export async function updatePage(
  collectionId: string,
  pageId: number,
  patch: UpdatePageInput,
  actorId: string,
): Promise<KbPageEntity> {
  if (Object.keys(patch).length === 0) {
    throw new ApiError("BAD_REQUEST", 400, "No fields to update.");
  }
  // Throws 404 before any mutation, and gives the byte re-measure a baseline.
  await getPage(collectionId, pageId);

  const sets: Partial<KbPageEntity> = {};
  if (patch.name !== undefined) {
    assertValidText("Page name", patch.name);
    sets.name = patch.name;
  }
  if (patch.description !== undefined) {
    if (patch.description != null) {
      assertValidText("Page description", patch.description);
    }
    sets.description = patch.description;
  }
  if (patch.sourceRef !== undefined) sets.sourceRef = patch.sourceRef;
  if (patch.contentType !== undefined) sets.contentType = patch.contentType;
  if (patch.groupId !== undefined) {
    if (patch.groupId != null) {
      await requirePayloadGroup(collectionId, patch.groupId);
    }
    sets.groupId = patch.groupId;
  }
  if (patch.content !== undefined) {
    sets.content = patch.content;
    sets.size = assertContentFits(patch.content);
    assertValidText("Page content", patch.content);
  }
  sets.updatedBy = actorId;
  sets.updatedAt = new Date();

  try {
    const [row] = await db
      .update(KbPageTable)
      .set(sets)
      .where(eq(KbPageTable.id, pageId))
      .returning();
    return row;
  } catch (err) {
    if (patch.name !== undefined) throwIfNameTaken(err, patch.name);
    throw err;
  }
}

export async function deletePage(
  collectionId: string,
  pageId: number,
): Promise<void> {
  await getPage(collectionId, pageId);
  await db.delete(KbPageTable).where(eq(KbPageTable.id, pageId));
}

// ────────────────────────── Invariants ───────────────────────────

/**
 * A move must keep the subtree inside the 2-level cap and must not create a
 * cycle. Depth and cycles are invisible to a single-row CHECK, so they live
 * here over the whole group set of the collection (capped by `kb.max_groups`,
 * so this is one small read).
 */
async function assertMoveLegal(
  collectionId: string,
  current: KbGroupEntity,
  nextParentId: number | null,
): Promise<void> {
  if (nextParentId === current.id) {
    throw new ApiError("BAD_REQUEST", 400, "A group cannot be its own parent.");
  }
  if (nextParentId === null) return;

  const groups: KbGroupEntity[] = await loadGroups(collectionId);
  const byId: Map<number, KbGroupEntity> = new Map(groups.map((g) => [g.id, g]));
  const target: KbGroupEntity | undefined = byId.get(nextParentId);
  if (!target) {
    throw new ApiError("NOT_FOUND", 404, "Target group is not in this collection.");
  }

  // Cycle: walking up from the target must not reach the moved node.
  let cursor: KbGroupEntity | undefined = target;
  while (cursor) {
    if (cursor.id === current.id) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Cannot move a group inside itself.",
        { reason: "CYCLE_REJECTED" },
      );
    }
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }

  // Depth: the level the moved node lands on, plus the height of its own
  // subtree, must stay within 2.
  const newLevel: number = target.parentId === null ? 2 : 3;
  const subtreeHeight: number = measureSubtreeHeight(groups, current.id);
  if (newLevel + subtreeHeight > MAX_GROUP_DEPTH) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "Groups are capped at two levels. Move the nested groups out first.",
      { reason: "DEPTH_EXCEEDED", maxDepth: MAX_GROUP_DEPTH },
    );
  }
}

/** 0 for a leaf group, 1 if it has children. */
function measureSubtreeHeight(
  groups: KbGroupEntity[],
  rootId: number,
): number {
  const childrenOf: Map<number, number[]> = new Map();
  for (const group of groups) {
    if (group.parentId === null) continue;
    const list: number[] | undefined = childrenOf.get(group.parentId);
    if (list) list.push(group.id);
    else childrenOf.set(group.parentId, [group.id]);
  }

  let height: number = 0;
  const stack: Array<{ id: number; depth: number }> = [{ id: rootId, depth: 0 }];
  while (stack.length > 0) {
    const node = stack.pop()!;
    height = Math.max(height, node.depth);
    for (const child of childrenOf.get(node.id) ?? []) {
      stack.push({ id: child, depth: node.depth + 1 });
    }
  }
  return height;
}

/** New groups attach under a level-1 group only. */
async function requireLevelOneParent(
  collectionId: string,
  parentId: number,
): Promise<KbGroupEntity> {
  const parent: KbGroupEntity = await loadGroup(collectionId, parentId);
  if (parent.parentId !== null) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "Groups are capped at two levels; nest no further.",
      { reason: "DEPTH_EXCEEDED", maxDepth: MAX_GROUP_DEPTH },
    );
  }
  return parent;
}

/**
 * A `group_id` supplied in a request body that points at another collection is
 * a malformed payload → 400. The same id in a URL path segment is a wrong
 * address → 404 via {@link loadGroup}.
 */
async function requirePayloadGroup(
  collectionId: string,
  groupId: number,
): Promise<KbGroupEntity> {
  const group: KbGroupEntity | undefined = await db
    .select()
    .from(KbGroupTable)
    .where(eq(KbGroupTable.id, groupId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!group || group.collectionId !== collectionId) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "groupId does not belong to this collection.",
      { reason: "GROUP_NOT_IN_COLLECTION" },
    );
  }
  return group;
}

async function loadGroup(
  collectionId: string,
  groupId: number,
): Promise<KbGroupEntity> {
  const rows: KbGroupEntity[] = await loadGroups(collectionId, [groupId]);
  const group: KbGroupEntity | undefined = rows[0];
  if (!group) throw new ApiError("NOT_FOUND", 404, "Group not found.");
  return group;
}

async function loadGroups(
  collectionId: string,
  ids?: number[],
): Promise<KbGroupEntity[]> {
  if (ids && ids.length === 0) return [];
  return db
    .select()
    .from(KbGroupTable)
    .where(
      ids
        ? and(
            eq(KbGroupTable.collectionId, collectionId),
            inArray(KbGroupTable.id, ids),
          )
        : eq(KbGroupTable.collectionId, collectionId),
    );
}

/** Page `content` is UTF-8 text; the stored-byte ceiling is the config budget. */
function assertContentFits(content: string): number {
  const size: number = Buffer.byteLength(content, "utf8");
  const max: number = PAGE_MAX_BYTES();
  if (size > max) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `Page content is ${size} bytes; the limit is ${max} (kb.page_max_bytes). Condense it or split it into more pages.`,
      { reason: "PAGE_TOO_LARGE", sizeBytes: size, maxBytes: max },
    );
  }
  return size;
}

/**
 * QUIRK: Postgres rejects a string holding a NUL byte or an unpaired
 * surrogate with `22021 invalid byte sequence`, and the row is never written —
 * so a paste that split a multi-byte grapheme, or embedded a NUL, would
 * otherwise surface as an opaque 500. `source_ref` is exempt: it is a
 * free-form maintenance note never read by any agent path (docs/kb.md).
 */
function assertValidText(field: string, value: string): void {
  const loneHighSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const loneLowSurrogate = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  if (
    value.includes("\u0000") ||
    loneHighSurrogate.test(value) ||
    loneLowSurrogate.test(value)
  ) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `${field} contains a NUL byte or an unpaired surrogate, which Postgres cannot store.`,
      { reason: "INVALID_TEXT" },
    );
  }
}

async function assertGroupLimit(collectionId: string): Promise<void> {
  const count: number = await countGroups(collectionId);
  const max: number = MAX_GROUPS_PER_COLLECTION();
  if (count >= max) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `This collection already holds ${max} groups (the configured limit). Raise kb.max_groups or remove some.`,
      { reason: "LIMIT_REACHED", kind: "group", count, max },
    );
  }
}

async function assertPageLimit(collectionId: string): Promise<void> {
  const count: number = await countPages(collectionId);
  const max: number = MAX_PAGES_PER_COLLECTION();
  if (count >= max) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `This collection already holds ${max} pages (the configured limit). Raise kb.max_pages or remove some.`,
      { reason: "LIMIT_REACHED", kind: "page", count, max },
    );
  }
}

async function countGroups(collectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(KbGroupTable)
    .where(eq(KbGroupTable.collectionId, collectionId));
  return row?.count ?? 0;
}

async function countPages(collectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(KbPageTable)
    .where(eq(KbPageTable.collectionId, collectionId));
  return row?.count ?? 0;
}

async function countGroupsByParent(parentId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(KbGroupTable)
    .where(eq(KbGroupTable.parentId, parentId));
  return row?.count ?? 0;
}

function throwIfNameTaken(err: unknown, name: string): void {
  if (isUniqueViolation(err)) {
    throw new ApiError(
      "CONFLICT",
      409,
      `The name "${name}" is already used in this scope.`,
      { reason: "NAME_TAKEN", name },
    );
  }
}
