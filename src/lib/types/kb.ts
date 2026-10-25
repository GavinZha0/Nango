/**
 * Client-side shapes for the knowledge-base REST API.
 *
 * Mirrors `src/lib/kb/service.ts` responses with timestamps narrowed to the
 * JSON strings the routes actually send. See docs/kb.md.
 */

import type { KbContentType } from "@/lib/db/schema";

export interface KbCollectionRow {
  id: string;
  /** LLM-facing slug — the string agents pass as `list_kb_pages(kb_name)`. */
  name: string;
  description: string | null;
  enabled: boolean;
  visibility: "private" | "public" | string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/kb` item: the row plus the two counts the left panel shows. */
export interface KbCollectionListItem extends KbCollectionRow {
  /** Level-1 groups only — the same set the editor header counts. */
  topLevelGroupCount: number;
  pageCount: number;
}

/**
 * The muted number beside a collection's name. One rule for both places that
 * print it — the panel row and the editor header — so they cannot disagree.
 *
 * It is the size of the collection's top level: its level-1 groups once an
 * author has made any, otherwise its pages, since a flat collection would
 * else read `(0)` while holding forty pages.
 */
export function kbTopTally(top: { groups: number; pages: number }): number {
  return top.groups > 0 ? top.groups : top.pages;
}

export interface KbGroupRow {
  id: number;
  collectionId: string;
  /** `null` = level-1 group. */
  parentId: number | null;
  name: string;
  description: string | null;
}

/** Page without its body — what the tree endpoint ships. */
export interface KbPageSummary {
  id: number;
  collectionId: string;
  /** `null` = page sits at the collection root (the "Top level" bucket). */
  groupId: number | null;
  name: string;
  description: string | null;
  contentType: KbContentType;
  /** Stored bytes, pre-computed server-side. */
  size: number;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/kb/[id]/pages/[pageId]` — the only read that carries `content`. */
export interface KbPageDetail extends KbPageSummary {
  content: string;
}

/**
 * `GET /api/kb/[id]` — the collection plus its whole tree, no page bodies. The
 * route ships the bare row, so the counts the editor prints are derived from
 * these two arrays rather than read off the response.
 */
export interface KbTreeDetail extends KbCollectionRow {
  groups: KbGroupRow[];
  pages: KbPageSummary[];
}
