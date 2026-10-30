/**
 * Domain service for the knowledge base: two levels (collection → page), all
 * structural invariants, all config-backed budgets.
 *
 * Folders are implicit path prefixes on a page, exactly as `skill_file` does it,
 * so every folder operation here is arithmetic over the collection's page paths
 * plus one transaction. Every write path goes through this module so those rules
 * cannot be bypassed. See docs/kb.md.
 */

import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  KbCollectionTable,
  KbPageTable,
  type KbCollectionEntity,
  type KbContentType,
  type KbPageEntity,
} from "@/lib/db/schema";
import { visibilitySql } from "@/lib/auth/permissions";
import { ApiError, type Session } from "@/lib/http/route-handlers";
import { isUniqueViolation } from "@/lib/http/validation";
import { alphabeticCompare } from "@/lib/utils/sort";
import {
  MAX_FOLDERS_PER_COLLECTION,
  MAX_PAGES_PER_COLLECTION,
  PAGE_MAX_BYTES,
} from "@/lib/kb/budgets";
import { MAX_FOLDER_DEPTH } from "@/lib/kb/limits";
import {
  ancestorFolders,
  distinctFolders,
  isUnderFolder,
  pathProblem,
  folderProblem,
  rewriteFolderPrefix,
  topLevelFolderCount,
} from "@/lib/kb/paths";

/** Columns a list/tree read returns for a page — `content` stays behind. */
export type KbPageSummary = Omit<KbPageEntity, "content">;

export interface CollectionListItem extends KbCollectionEntity {
  /** Level-1 folders only: the panel prints this, or `pageCount` when it is 0. */
  folderCount: number;
  pageCount: number;
}

export interface CreateCollectionInput {
  name: string;
  /**
   * Optional, and a collection created without one is inserted disabled: see
   * the `enabled ⇒ description` CONTRACT on {@link updateCollection}.
   */
  description?: string | null;
  visibility?: "private" | "public";
  createdBy: string;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  visibility?: "private" | "public";
}

/** One page as a folder import hands it over — the body is already decoded text. */
export interface ImportPageInput {
  path: string;
  content: string;
  contentType?: KbContentType;
  description?: string | null;
  sourceRef?: string | null;
}

/**
 * A folder of text files, already collected client-side.
 *
 * There is no `description`: the importer has not read the corpus yet, which is
 * the whole reason it is importing it. The collection lands disabled with a NULL
 * description and is published once the author has written its routing line.
 */
export interface ImportCollectionInput {
  name: string;
  visibility?: "private" | "public";
  createdBy: string;
  pages: ImportPageInput[];
}

export interface CreatePageInput {
  path: string;
  description?: string | null;
  content: string;
  contentType?: KbContentType;
  sourceRef?: string | null;
}

export interface UpdatePageInput {
  /** Rename or move — one field, because a path is both. */
  path?: string;
  description?: string | null;
  content?: string;
  contentType?: KbContentType;
  sourceRef?: string | null;
}

// ──────────────────────────── Reads ──────────────────────────────

/** Collections visible to the session, each with its folder and page tallies. */
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

  const pathsByCollection = await loadPagePathsByCollection(
    rows.map((row) => row.id),
  );

  return rows.map((row) => {
    const paths: string[] = pathsByCollection.get(row.id) ?? [];
    return {
      ...row,
      folderCount: topLevelFolderCount(paths),
      pageCount: paths.length,
    };
  });
}

/**
 * The collection's pages, minus their bodies, in the order the agent-facing
 * index uses.
 *
 * CONTRACT: sorted here with `alphabeticCompare`, once, so the editor tree and
 * the index cannot drift. Postgres orders bytes without `COLLATE`, which puts
 * `chapter-10` before `chapter-2`. The tree is derived from these paths by the
 * client — there is no folder row to join.
 */
export async function getPages(collectionId: string): Promise<KbPageSummary[]> {
  const rows: KbPageSummary[] = await db
    .select({
      id: KbPageTable.id,
      collectionId: KbPageTable.collectionId,
      path: KbPageTable.path,
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
    .orderBy(asc(KbPageTable.path));

  return [...rows].sort((a, b) => alphabeticCompare(a.path, b.path));
}

/** One page with its body — the only read that returns `content`. */
export async function getPage(
  collectionId: string,
  path: string,
): Promise<KbPageEntity> {
  const [row] = await db
    .select()
    .from(KbPageTable)
    .where(
      and(eq(KbPageTable.collectionId, collectionId), eq(KbPageTable.path, path)),
    )
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", 404, "Page not found.");
  return row;
}

// ──────────────────────── Collection writes ──────────────────────

export async function createCollection(
  input: CreateCollectionInput,
): Promise<KbCollectionEntity> {
  assertValidText("KB name", input.name);
  // Whitespace is not prose: the edge trims, and this keeps a hand-run script
  // from minting an invisible routing line.
  const description = input.description?.trim() || null;
  if (description !== null) assertValidText("KB description", description);
  try {
    const [row] = await db
      .insert(KbCollectionTable)
      .values({
        name: input.name,
        description,
        // A collection with no routing line has nothing to route to, so it is
        // not mounted. The author fills the description and flips `enabled`.
        enabled: description !== null,
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

/**
 * Create a collection and every page it imports in one transaction.
 *
 * CONTRACT: there is no half-imported collection. A page that trips an invariant
 * rolls the `kb_collection` insert back with it, so this path needs no
 * compensating delete and a retry starts from nothing — which is what makes a
 * rejected import safe to fix and re-run.
 *
 * CONTRACT: the result is unpublished — `description` NULL, `enabled` false. A
 * folder nobody has read yet has no routing line, and an import that silently
 * mounted itself in every bound agent would be the one write path that could.
 *
 * The per-page rules are the same ones {@link createPage} enforces; only the
 * budgets are measured differently, because an import adds a whole set at once
 * (see {@link assertImportRoom}).
 */
export async function importCollection(
  input: ImportCollectionInput,
): Promise<KbCollectionEntity> {
  assertValidText("KB name", input.name);
  if (input.pages.length === 0) {
    throw new ApiError("BAD_REQUEST", 400, "The folder held no importable page.");
  }

  const paths: string[] = [];
  for (const page of input.pages) {
    assertLegalPath(page.path);
    if (page.description != null) {
      assertValidText("Page description", page.description);
    }
    assertValidText("Page content", page.content);
    assertContentFits(page.content);
    // Every earlier path is the baseline: this catches a subtree that nests
    // inside one of its own page names, and a manifest that repeats a path.
    assertNoFolderClash(paths, page.path);
    paths.push(page.path);
  }
  assertImportRoom(paths);

  try {
    return await db.transaction(async (tx) => {
      const [collection] = await tx
        .insert(KbCollectionTable)
        .values({
          name: input.name,
          description: null,
          enabled: false,
          visibility: input.visibility ?? "private",
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })
        .returning();
      await tx.insert(KbPageTable).values(
        input.pages.map((page) => ({
          collectionId: collection.id,
          path: page.path,
          description: page.description ?? null,
          content: page.content,
          contentType: page.contentType ?? "text/markdown",
          size: Buffer.byteLength(page.content, "utf8"),
          sourceRef: page.sourceRef ?? null,
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })),
      );
      return collection;
    });
  } catch (err) {
    throwIfNameTaken(err, input.name);
    throw err;
  }
}

/**
 * CONTRACT: `enabled ⇒ description` is enforced here, not at the API edge, so
 * no caller can mount a collection whose routing line is empty. A prompt block
 * naming a collection it cannot describe is worse than an unmounted one: the
 * agent trusts the bullet and the author believes the corpus is live.
 *
 * Both directions are refused — enabling a collection with no prose, and
 * blanking the prose of one that is mounted. Disabling first is the answer to
 * the second, and it is a one-click change rather than a silent unmount.
 */
export async function updateCollection(
  collectionId: string,
  patch: UpdateCollectionInput,
  actorId: string,
): Promise<KbCollectionEntity> {
  if (Object.keys(patch).length === 0) {
    throw new ApiError("BAD_REQUEST", 400, "No fields to update.");
  }
  if (patch.name !== undefined) assertValidText("KB name", patch.name);
  if (patch.description) assertValidText("KB description", patch.description);
  if (patch.enabled !== undefined || patch.description !== undefined) {
    await assertPublishable(collectionId, patch);
  }
  try {
    const [row] = await db
      .update(KbCollectionTable)
      .set({ ...patch, updatedBy: actorId, updatedAt: new Date() })
      .where(eq(KbCollectionTable.id, collectionId))
      .returning();
    if (!row) {
      throw new ApiError("NOT_FOUND", 404, "Knowledge base not found.");
    }
    return row;
  } catch (err) {
    if (patch.name !== undefined) throwIfNameTaken(err, patch.name);
    throw err;
  }
}

/** The merged post-patch state must satisfy `enabled ⇒ description`. */
async function assertPublishable(
  collectionId: string,
  patch: UpdateCollectionInput,
): Promise<void> {
  const [current] = await db
    .select({ description: KbCollectionTable.description, enabled: KbCollectionTable.enabled })
    .from(KbCollectionTable)
    .where(eq(KbCollectionTable.id, collectionId))
    .limit(1);
  if (!current) return; // the update below reports NOT_FOUND

  const description =
    patch.description !== undefined ? patch.description : current.description;
  const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
  // Whitespace is not prose, and an invisible routing line is the failure this
  // gate exists to prevent.
  if (!enabled || (description ?? "").trim() !== "") return;

  throw new ApiError(
    "BAD_REQUEST",
    400,
    current.enabled
      ? "This KB is enabled, so its description cannot be empty. Disable it first."
      : "Set a description before enabling this KB.",
    { reason: "DESCRIPTION_REQUIRED" },
  );
}

/**
 * Hard delete. `kb_page` cascades and `builtin_agent_tool` releases its binding;
 * ownership columns are SET NULL so no user purge ever reaches this path.
 */
export async function deleteCollection(collectionId: string): Promise<void> {
  await db
    .delete(KbCollectionTable)
    .where(eq(KbCollectionTable.id, collectionId));
}

// ─────────────────────────── Page writes ─────────────────────────

export async function createPage(
  collectionId: string,
  input: CreatePageInput,
  actorId: string,
): Promise<KbPageEntity> {
  assertLegalPath(input.path);
  if (input.description != null) {
    assertValidText("Page description", input.description);
  }
  const existing: string[] = await loadPagePaths(collectionId);
  assertNoFolderClash(existing, input.path);
  assertPageRoom(existing.length);
  assertFolderBudget(existing, input.path);
  const size: number = assertContentFits(input.content);
  assertValidText("Page content", input.content);

  try {
    const [row] = await db
      .insert(KbPageTable)
      .values({
        collectionId,
        path: input.path,
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
    throwIfPathTaken(err, input.path);
    throw err;
  }
}

/**
 * Rename, move, or edit in place. `path` is both the address and the handle, so
 * a rename and a move are the same field.
 */
export async function updatePage(
  collectionId: string,
  path: string,
  patch: UpdatePageInput,
  actorId: string,
): Promise<KbPageEntity> {
  if (Object.keys(patch).length === 0) {
    throw new ApiError("BAD_REQUEST", 400, "No fields to update.");
  }
  // Throws 404 before any mutation, and gives the rewrite checks their baseline.
  const current: KbPageEntity = await getPage(collectionId, path);

  const sets: Partial<KbPageEntity> = {};
  if (patch.description !== undefined) {
    if (patch.description != null) {
      assertValidText("Page description", patch.description);
    }
    sets.description = patch.description;
  }
  if (patch.sourceRef !== undefined) sets.sourceRef = patch.sourceRef;
  if (patch.contentType !== undefined) sets.contentType = patch.contentType;
  if (patch.content !== undefined) {
    sets.content = patch.content;
    sets.size = assertContentFits(patch.content);
    assertValidText("Page content", patch.content);
  }

  const newPath: string | undefined = patch.path;
  if (newPath !== undefined) {
    assertLegalPath(newPath);
    if (newPath !== current.path) {
      const others: string[] = (await loadPagePaths(collectionId)).filter(
        (p) => p !== current.path,
      );
      assertNoFolderClash(others, newPath);
      assertFolderBudget(others, newPath);
      sets.path = newPath;
    }
  }
  sets.updatedBy = actorId;
  sets.updatedAt = new Date();

  try {
    const [row] = await db
      .update(KbPageTable)
      .set(sets)
      .where(eq(KbPageTable.id, current.id))
      .returning();
    return row;
  } catch (err) {
    if (newPath !== undefined) throwIfPathTaken(err, newPath);
    throw err;
  }
}

export async function deletePage(
  collectionId: string,
  path: string,
): Promise<void> {
  const current: KbPageEntity = await getPage(collectionId, path);
  await db.delete(KbPageTable).where(eq(KbPageTable.id, current.id));
}

// ──────────────────────── Folder operations ──────────────────────

/**
 * Rename or move a folder, which rewrites the path of every page under it.
 *
 * `newFolder` may be inside the folder itself (`a` → `a/b` nests it one level
 * deeper) as long as the result stays within the depth cap; it may not land on
 * top of other pages.
 */
export async function renameFolder(
  collectionId: string,
  folder: string,
  newFolder: string,
  actorId: string,
): Promise<number> {
  assertLegalFolder(newFolder);
  const rows: Array<{ id: number; path: string }> = await loadPageRows(
    collectionId,
  );
  const inside = rows.filter((row) => isUnderFolder(row.path, folder));
  if (inside.length === 0) {
    throw new ApiError("NOT_FOUND", 404, `Folder not found: ${folder}`);
  }
  const outside: string[] = rows
    .filter((row) => !isUnderFolder(row.path, folder))
    .map((row) => row.path);

  const rewrites: Array<{ id: number; newPath: string }> = inside.map((row) => {
    const newPath: string = rewriteFolderPrefix(row.path, folder, newFolder);
    assertLegalPath(newPath);
    assertNoFolderClash(outside, newPath);
    return { id: row.id, newPath };
  });
  assertFolderBudget(outside, ...rewrites.map((row) => row.newPath));

  await db.transaction(async (tx) => {
    for (const page of rewrites) {
      await tx
        .update(KbPageTable)
        .set({ path: page.newPath, updatedBy: actorId, updatedAt: new Date() })
        .where(eq(KbPageTable.id, page.id));
    }
  });

  return rewrites.length;
}

/**
 * Delete a folder by deleting every page under it. Nothing survives a folder
 * delete: a directory is a name its pages share, so removing the pages removes
 * it — and a nested folder goes with its parent because it is only ever a longer
 * prefix of those same pages.
 */
export async function deleteFolder(
  collectionId: string,
  folder: string,
): Promise<number> {
  const rows: Array<{ id: number; path: string }> = await loadPageRows(
    collectionId,
  );
  const ids: number[] = rows
    .filter((row) => isUnderFolder(row.path, folder))
    .map((row) => row.id);
  if (ids.length === 0) {
    throw new ApiError("NOT_FOUND", 404, `Folder not found: ${folder}`);
  }
  await db.delete(KbPageTable).where(inArray(KbPageTable.id, ids));
  return ids.length;
}

// ────────────────────────── Invariants ───────────────────────────

/** The collection's page rows — the address set every folder rule reads. */
async function loadPageRows(
  collectionId: string,
): Promise<Array<{ id: number; path: string }>> {
  const rows: Array<{ id: number; path: string }> = await db
    .select({ id: KbPageTable.id, path: KbPageTable.path })
    .from(KbPageTable)
    .where(eq(KbPageTable.collectionId, collectionId));
  return rows;
}

async function loadPagePaths(collectionId: string): Promise<string[]> {
  return (await loadPageRows(collectionId)).map((row) => row.path);
}

/**
 * Paths of many collections at once, for the panel's list.
 *
 * The tallies are derived in JS from these strings — the same helpers the
 * editor header uses — because a folder only exists as a prefix, and one
 * `count(DISTINCT split_part(...))` would be a second implementation of that
 * rule the two surfaces could disagree with.
 */
async function loadPagePathsByCollection(
  ids: string[],
): Promise<Map<string, string[]>> {
  const rows: Array<{ collectionId: string; path: string }> = await db
    .select({ collectionId: KbPageTable.collectionId, path: KbPageTable.path })
    .from(KbPageTable)
    .where(inArray(KbPageTable.collectionId, ids));
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = out.get(row.collectionId);
    if (bucket) bucket.push(row.path);
    else out.set(row.collectionId, [row.path]);
  }
  return out;
}

function assertLegalPath(path: string): void {
  const problem: string | null = pathProblem(path);
  if (problem) {
    throw new ApiError("BAD_REQUEST", 400, `Page path ${problem}.`, {
      reason: "INVALID_PATH",
      maxDepth: MAX_FOLDER_DEPTH,
    });
  }
}

function assertLegalFolder(folder: string): void {
  const problem: string | null = folderProblem(folder);
  if (problem) {
    throw new ApiError("BAD_REQUEST", 400, `Folder path ${problem}.`, {
      reason: "INVALID_PATH",
      maxDepth: MAX_FOLDER_DEPTH,
    });
  }
}

/**
 * A folder and a page cannot share one name: the tree, the index and the URL all
 * read `a` as either a directory or a document, so a collection holding both is
 * ambiguous rather than merely untidy.
 */
function assertNoFolderClash(existing: readonly string[], path: string): void {
  for (const other of existing) {
    if (other === path) throw folderClash(path);
    if (isUnderFolder(other, path) || isUnderFolder(path, other)) {
      throw folderClash(path);
    }
  }
}

function folderClash(path: string): ApiError {
  return new ApiError(
    "CONFLICT",
    409,
    `A page or folder already exists at "${path}".`,
    { reason: "PATH_TAKEN", path },
  );
}

/**
 * A write may only imply a folder the collection does not already have while it
 * is under the budget. Checked against the post-write path set, so a rename that
 * frees one prefix and spends another never trips the limit.
 */
function assertFolderBudget(
  existing: readonly string[],
  ...added: string[]
): void {
  const before: Set<string> = new Set(distinctFolders(existing));
  const after: Set<string> = new Set([
    ...before,
    ...added.flatMap((path) => ancestorFolders(path)),
  ]);
  const grown: number = after.size - before.size;
  if (grown === 0) return;
  const max: number = MAX_FOLDERS_PER_COLLECTION();
  if (after.size > max) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `This write would leave ${after.size} folders in this KB, over the limit of ${max}. Raise kb.max_folders, or put the page in a folder that already exists.`,
      { reason: "LIMIT_REACHED", kind: "folder", count: after.size, max },
    );
  }
}

/**
 * The two budgets an import can blow on its own, measured on the set it brings.
 *
 * A fresh collection has no baseline to grow from, so — unlike a single write —
 * the whole folder set and the whole page count are checked at once. `MAX_PAGES`
 * also caps the upload at the transport edge, but the domain rule stays here so
 * no caller can reach the insert without it.
 */
function assertImportRoom(paths: readonly string[]): void {
  const maxPages: number = MAX_PAGES_PER_COLLECTION();
  if (paths.length > maxPages) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `This import brings ${paths.length} pages, over the limit of ${maxPages}. Raise kb.max_pages, or split the folder across more knowledge bases.`,
      { reason: "LIMIT_REACHED", kind: "page", count: paths.length, max: maxPages },
    );
  }
  const folders: string[] = distinctFolders(paths);
  const maxFolders: number = MAX_FOLDERS_PER_COLLECTION();
  if (folders.length > maxFolders) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `This import would leave ${folders.length} folders in this KB, over the limit of ${maxFolders}. Raise kb.max_folders, or flatten the folder tree.`,
      { reason: "LIMIT_REACHED", kind: "folder", count: folders.length, max: maxFolders },
    );
  }
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

/**
 * The page ceiling, measured on the address set the caller already loaded — a
 * create is the only write that can add a row.
 */
function assertPageRoom(count: number): void {
  const max: number = MAX_PAGES_PER_COLLECTION();
  if (count >= max) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      `This KB already holds ${max} pages (the configured limit). Raise kb.max_pages or remove some.`,
      { reason: "LIMIT_REACHED", kind: "page", count, max },
    );
  }
}

function throwIfPathTaken(err: unknown, path: string): void {
  if (isUniqueViolation(err)) {
    throw folderClash(path);
  }
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
