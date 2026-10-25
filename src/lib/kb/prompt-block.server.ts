/**
 * Build the "Available knowledge" system-prompt block for an agent.
 *
 * Rendered whole on every dispatch — there is no mount byte budget and no
 * cache, so a KB write needs no invalidation. See docs/kb.md.
 */

import "server-only";

import {
  countKbPagesByGroup,
  listEnabledKbCollectionsByIds,
  listKbGroupLinesByIds,
  type KbGroupLine,
} from "./lookup";

export interface KbPromptBlock {
  /** The block itself, ready to concatenate into the system prompt with a
   *  leading newline; empty string when no usable collection is bound (the
   *  caller skips the concatenation entirely). */
  promptBlock: string;
}

const INTRO =
  "When a question matches one of these knowledge bases, call " +
  "`list_kb_pages(kb_name)` to see its index, then " +
  "`read_kb_page(kb_name, page_name)` for the page you need. Page bodies " +
  "are never shown here — do not assume you know a KB's contents from the " +
  "lines below.";

/**
 * Build the block from the `kb_collection` ids bound to one agent. Three
 * queries per dispatch for the whole bound set — not per collection — with no
 * cache and no byte budget: bounded by `kb.max_pages` (50), so rebuilding it
 * every time stays cheap and a KB write needs no invalidation.
 */
export async function buildKbPromptBlock(
  kbCollectionIds: readonly string[],
): Promise<KbPromptBlock> {
  if (kbCollectionIds.length === 0) return { promptBlock: "" };

  const [collections, groupLines, pageCounts] = await Promise.all([
    listEnabledKbCollectionsByIds(kbCollectionIds),
    listKbGroupLinesByIds(kbCollectionIds),
    countKbPagesByGroup(kbCollectionIds),
  ]);
  if (collections.length === 0) return { promptBlock: "" };

  const groupsByCollection = new Map<string, KbGroupLine[]>();
  for (const group of groupLines) {
    const bucket = groupsByCollection.get(group.collectionId);
    if (bucket) bucket.push(group);
    else groupsByCollection.set(group.collectionId, [group]);
  }

  // `collectionId:groupId` — `0` is the ungrouped bucket, since group ids
  // start at 1 and one counter line per collection is all this needs.
  const pageCount = new Map<string, number>();
  for (const row of pageCounts) {
    pageCount.set(`${row.collectionId}:${row.groupId ?? 0}`, row.count);
  }

  const lines: string[] = [];
  for (const collection of collections) {
    // `description` is required at the API edge but the column is nullable, so
    // a legacy row renders as a bare name rather than a dangling colon.
    const help = collection.description
      ? `: ${flatten(collection.description)}`
      : "";
    lines.push(`- **${flatten(collection.name)}**${help}`);
    for (const group of groupsByCollection.get(collection.id) ?? []) {
      const count =
        pageCount.get(`${collection.id}:${group.id}`) ?? 0;
      const help = group.description ? ` — ${flatten(group.description)}` : "";
      const indent = group.parentId === null ? "  " : "    ";
      lines.push(
        `${indent}- ${flatten(group.name)} (${count} pages)${help}`,
      );
    }
    const ungrouped = pageCount.get(`${collection.id}:0`) ?? 0;
    if (ungrouped > 0) lines.push(`  - (${ungrouped} ungrouped pages)`);
  }

  return {
    promptBlock: `## Available knowledge\n\n${INTRO}\n\n${lines.join("\n")}`,
  };
}

/**
 * Collapse whitespace runs to single spaces.
 *
 * SECURITY: `name` and `description` are author text, and this block is pasted
 * into the system prompt — a newline in a description would otherwise mint its
 * own bullet and let one entry fake the shape of another KB.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
