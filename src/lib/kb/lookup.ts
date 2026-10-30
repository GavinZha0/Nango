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

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  KbCollectionTable,
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

/** A page as the derived index shows it — a path, a summary, never a body. */
export interface KbIndexPage {
  path: string;
  description: string | null;
}

/** One page path of one bound collection — all the prompt block needs. */
export interface KbPagePathRow {
  collectionId: string;
  path: string;
}

export interface KbPageContent {
  path: string;
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

/**
 * Every page path of the given collections, one read for the whole bound set.
 *
 * Folders are implicit prefixes, so the block's structure comes from these
 * strings — there is no second table to join and no per-collection query.
 */
export async function listKbPagePathsByIds(
  ids: readonly string[],
): Promise<KbPagePathRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      collectionId: KbPageTable.collectionId,
      path: KbPageTable.path,
    })
    .from(KbPageTable)
    .where(inArray(KbPageTable.collectionId, [...ids]));
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

/**
 * Every page of one collection, addressed by full path.
 *
 * QUIRK: Postgres would order these by bytes, so `alphabeticCompare` runs in
 * JS after the read; numeric segments sort by value (`chapter-2` before
 * `chapter-10`). The same ordering builds the tree in the editor and renders
 * the prompt block, so an agent sees a page where the author expects it.
 */
export async function listKbIndexPages(
  collectionId: string,
): Promise<KbIndexPage[]> {
  const rows = await db
    .select({
      path: KbPageTable.path,
      description: KbPageTable.description,
    })
    .from(KbPageTable)
    .where(eq(KbPageTable.collectionId, collectionId));
  return rows.sort((a, b) => alphabeticCompare(a.path, b.path));
}

/**
 * Fetch one page's bytes by its collection-wide path handle.
 *
 * `source_ref` is not selected: it is a maintenance note and must never reach
 * an agent (docs/kb.md).
 */
export async function getKbPageByPath(
  collectionId: string,
  path: string,
): Promise<KbPageContent | null> {
  const rows = await db
    .select({
      path: KbPageTable.path,
      description: KbPageTable.description,
      content: KbPageTable.content,
      contentType: KbPageTable.contentType,
    })
    .from(KbPageTable)
    .where(
      and(
        eq(KbPageTable.collectionId, collectionId),
        eq(KbPageTable.path, path),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
