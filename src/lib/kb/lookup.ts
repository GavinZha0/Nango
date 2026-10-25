/**
 * Server-side KB reads for the agent runtime: the mounted prompt block's rows
 * and the two tool surfaces (`list_kb_pages`, `read_kb_page`).
 *
 * Deliberately free of RBAC. Binding a collection to an agent IS the grant;
 * the runtime does not re-evaluate visibility per call, which is how skills and
 * data sources already work. The authoring surface (`service.ts` + the API
 * routes) is where visibility is enforced. See docs/kb.md.
 */

import "server-only";

import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  KbCollectionTable,
  KbGroupTable,
  KbPageTable,
  type KbContentType,
} from "@/lib/db/schema";
import { alphabeticCompare } from "@/lib/utils/sort";

/** One collection as the runtime sees it. `visibility` is not surfaced. */
export interface KbCollectionEntry {
  id: string;
  name: string;
  description: string | null;
}

export interface KbGroupLine {
  collectionId: string;
  id: number;
  name: string;
  /** NULL = level 1. */
  parentId: number | null;
  description: string | null;
}

/** A page as the derived index shows it — never its `content`. */
export interface KbIndexPage {
  name: string;
  description: string | null;
}

/**
 * A group as the derived index shows it. Row ids stay internal: an agent
 * addresses a group by name or not at all, so exposing `id` would invite it
 * into a later argument and make the name handle optional.
 */
export interface KbIndexGroup {
  name: string;
  description: string | null;
  /** NULL = level 1, so a level-2 group is recognizable by its parent's name. */
  parentName: string | null;
  pages: KbIndexPage[];
}

export interface KbIndex {
  /** Level-1 groups each followed by their children, both alphabetically. */
  groups: KbIndexGroup[];
  /** Pages with `group_id IS NULL` — addressable by page name only. */
  ungroupedPages: KbIndexPage[];
}

export interface KbPageContent {
  name: string;
  description: string | null;
  content: string;
  contentType: KbContentType;
}

/**
 * Bound collections that are still `enabled`, ordered the way the block
 * renders them. A disabled collection is absent rather than annotated: the
 * agent must not be able to tell the difference from "not bound".
 */
export async function listEnabledKbCollectionsByIds(
  ids: readonly string[],
): Promise<KbCollectionEntry[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: KbCollectionTable.id,
      name: KbCollectionTable.name,
      description: KbCollectionTable.description,
    })
    .from(KbCollectionTable)
    .where(
      and(
        inArray(KbCollectionTable.id, [...ids]),
        eq(KbCollectionTable.enabled, true),
      ),
    );
  return rows.sort((a, b) => alphabeticCompare(a.name, b.name));
}

/** Every group of the given collections. Page counts come from {@link countKbPagesByGroup}. */
export async function listKbGroupLinesByIds(
  ids: readonly string[],
): Promise<KbGroupLine[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      collectionId: KbGroupTable.collectionId,
      id: KbGroupTable.id,
      name: KbGroupTable.name,
      parentId: KbGroupTable.parentId,
      description: KbGroupTable.description,
    })
    .from(KbGroupTable)
    .where(inArray(KbGroupTable.collectionId, [...ids]));
  return orderGroupTree(rows);
}

/** Page total for one group of one collection; `groupId: null` is the ungrouped bucket. */
export interface KbPageGroupCount {
  collectionId: string;
  groupId: number | null;
  count: number;
}

/**
 * Page totals per group, one grouped read for the whole bound set. The block
 * only needs `(N pages)`; `list_kb_pages` needs the names and does its own
 * read.
 */
export async function countKbPagesByGroup(
  ids: readonly string[],
): Promise<KbPageGroupCount[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      collectionId: KbPageTable.collectionId,
      groupId: KbPageTable.groupId,
      count: count(),
    })
    .from(KbPageTable)
    .where(inArray(KbPageTable.collectionId, [...ids]))
    .groupBy(KbPageTable.collectionId, KbPageTable.groupId);
}

/**
 * Resolve a `kb_name` argument for a specific agent.
 *
 * CONTRACT: an unknown slug, a collection bound to a different agent, and a
 * disabled collection are indistinguishable here — all return null, and the
 * tool turns that into one `KB_NOT_AVAILABLE` code. Nothing on this path may
 * reveal that a name exists but is not reachable: `## Available knowledge` is
 * the discovery channel, not the error path (docs/kb.md).
 */
export async function resolveKbCollectionForAgent(
  name: string,
  allowedIds: ReadonlySet<string>,
): Promise<KbCollectionEntry | null> {
  if (allowedIds.size === 0) return null;
  const rows = await db
    .select({
      id: KbCollectionTable.id,
      name: KbCollectionTable.name,
      description: KbCollectionTable.description,
    })
    .from(KbCollectionTable)
    .where(
      and(
        eq(KbCollectionTable.name, name),
        eq(KbCollectionTable.enabled, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row && allowedIds.has(row.id) ? row : null;
}

/** The derived index of one collection: groups with their pages, plus the ungrouped tail. */
export async function getKbIndex(collectionId: string): Promise<KbIndex> {
  const [groupRows, pageRows] = await Promise.all([
    db
      .select({
        collectionId: KbGroupTable.collectionId,
        id: KbGroupTable.id,
        name: KbGroupTable.name,
        parentId: KbGroupTable.parentId,
        description: KbGroupTable.description,
      })
      .from(KbGroupTable)
      .where(eq(KbGroupTable.collectionId, collectionId)),
    db
      .select({
        name: KbPageTable.name,
        description: KbPageTable.description,
        groupId: KbPageTable.groupId,
      })
      .from(KbPageTable)
      .where(eq(KbPageTable.collectionId, collectionId)),
  ]);

  const ordered = orderGroupTree(groupRows);
  const byGroup = new Map<number, KbIndexPage[]>();
  const ungroupedPages: KbIndexPage[] = [];
  for (const page of pageRows.sort((a, b) => alphabeticCompare(a.name, b.name))) {
    const summary = { name: page.name, description: page.description };
    if (page.groupId === null) {
      ungroupedPages.push(summary);
    } else {
      const bucket = byGroup.get(page.groupId);
      if (bucket) bucket.push(summary);
      else byGroup.set(page.groupId, [summary]);
    }
  }

  const nameById = new Map(ordered.map((g) => [g.id, g.name]));
  const groups: KbIndexGroup[] = ordered.map((g) => ({
    name: g.name,
    description: g.description,
    parentName: g.parentId === null ? null : (nameById.get(g.parentId) ?? null),
    pages: byGroup.get(g.id) ?? [],
  }));

  return { groups, ungroupedPages };
}

/**
 * Fetch one page's bytes by its collection-wide name handle.
 *
 * `source_ref` is not selected: it is a maintenance note and must never reach
 * an agent (docs/kb.md).
 */
export async function getKbPageByName(
  collectionId: string,
  pageName: string,
): Promise<KbPageContent | null> {
  const rows = await db
    .select({
      name: KbPageTable.name,
      description: KbPageTable.description,
      content: KbPageTable.content,
      contentType: KbPageTable.contentType,
    })
    .from(KbPageTable)
    .where(
      and(
        eq(KbPageTable.collectionId, collectionId),
        eq(KbPageTable.name, pageName),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Level-1 groups alphabetically, each immediately followed by its children
 * alphabetically — the order both the injected block and `list_kb_pages`
 * render in.
 *
 * QUIRK: Postgres would order these by bytes, so `alphabeticCompare` runs in
 * JS after the read; numeric segments sort by value (`chapter-2` before
 * `chapter-10`). See docs/kb.md.
 */
function orderGroupTree<T extends { name: string; id: number; parentId: number | null }>(
  rows: T[],
): T[] {
  const byName = [...rows].sort((a, b) => alphabeticCompare(a.name, b.name));
  const childrenOf = new Map<number, T[]>();
  const roots: T[] = [];
  for (const row of byName) {
    if (row.parentId === null) roots.push(row);
    else {
      const siblings = childrenOf.get(row.parentId);
      if (siblings) siblings.push(row);
      else childrenOf.set(row.parentId, [row]);
    }
  }
  const out: T[] = [];
  for (const root of roots) {
    out.push(root);
    // A child whose parent row is missing cannot happen (FK), but a group
    // parented to a row outside this read still must not vanish from the list.
    out.push(...(childrenOf.get(root.id) ?? []));
  }
  const seen = new Set(out.map((g) => g.id));
  for (const row of byName) if (!seen.has(row.id)) out.push(row);
  return out;
}
