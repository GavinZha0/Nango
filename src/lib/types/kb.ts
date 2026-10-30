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
  /** Level-1 folders only: what the panel prints, or `pageCount` when it is 0. */
  folderCount: number;
  pageCount: number;
}

/**
 * The muted number beside a collection's name. One rule for both places that
 * print it — the panel row and the editor header — so they cannot disagree.
 *
 * It is the size of the collection's top level: its folders once an author has
 * made any, otherwise its pages, since a flat collection would else read `(0)`
 * while holding forty pages.
 */
export function kbTopTally(top: { folders: number; pages: number }): number {
  return top.folders > 0 ? top.folders : top.pages;
}

/** Page without its body — what the collection read ships. */
export interface KbPageSummary {
  id: number;
  collectionId: string;
  /** `/`-separated, folder prefixes included; `""` is impossible. */
  path: string;
  description: string | null;
  contentType: KbContentType;
  /** Stored bytes, pre-computed server-side. */
  size: number;
  sourceRef: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/kb/[id]/pages/[...path]` — the only read that carries `content`. */
export interface KbPageDetail extends KbPageSummary {
  content: string;
}

/**
 * `GET /api/kb/[id]` — the collection plus every page summary. Folders are not
 * in the payload: the tree is derived from these paths, so nothing an author
 * sees can disagree with where a page actually lives.
 */
export interface KbCollectionDetail extends KbCollectionRow {
  pages: KbPageSummary[];
}
