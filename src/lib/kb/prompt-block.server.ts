/**
 * Build the "Available knowledge" system-prompt block for an agent.
 *
 * Rendered whole on every dispatch — there is no mount byte budget and no
 * cache, so a KB write needs no invalidation. See docs/kb.md.
 */

import "server-only";

import { folderOf, folderDepth, distinctFolders } from "@/lib/kb/paths";
import {
  listEnabledKbCollectionsByIds,
  listKbPagePathsByIds,
} from "./lookup";

export interface KbPromptBlock {
  /** The block itself, ready to concatenate into the system prompt with a
   *  leading newline; empty string when no usable collection is bound (the
   *  caller skips the concatenation entirely). */
  promptBlock: string;
}

const INTRO =
  "When a question matches one of these knowledge bases, call " +
  "`list_kb_pages(kb_name)` to see its pages, then " +
  "`read_kb_page(kb_name, page_path)` for the page you need. Page bodies " +
  "are never shown here — do not assume you know a KB's contents from the " +
  "lines below.";

/**
 * Build the block from the `kb_collection` ids bound to one agent. Two queries
 * per dispatch for the whole bound set — not per collection — with no cache and
 * no byte budget: bounded by `kb.max_pages` (50), so rebuilding it every time
 * stays cheap and a KB write needs no invalidation.
 */
export async function buildKbPromptBlock(
  kbCollectionIds: readonly string[],
): Promise<KbPromptBlock> {
  if (kbCollectionIds.length === 0) return { promptBlock: "" };

  const [collections, pagePaths] = await Promise.all([
    listEnabledKbCollectionsByIds(kbCollectionIds),
    listKbPagePathsByIds(kbCollectionIds),
  ]);
  if (collections.length === 0) return { promptBlock: "" };

  const pathsByCollection = new Map<string, string[]>();
  for (const row of pagePaths) {
    const bucket = pathsByCollection.get(row.collectionId);
    if (bucket) bucket.push(row.path);
    else pathsByCollection.set(row.collectionId, [row.path]);
  }

  const lines: string[] = [];
  for (const collection of collections) {
    lines.push(
      `- **${flatten(collection.name)}**${
        collection.description ? `: ${flatten(collection.description)}` : ""
      }`,
    );
    for (const line of outline(pathsByCollection.get(collection.id) ?? [])) {
      lines.push(line);
    }
  }

  return {
    promptBlock: `## Available knowledge\n\n${INTRO}\n\n${lines.join("\n")}`,
  };
}

/**
 * The collection's folder outline: one indented line per implied folder with
 * the number of pages sitting directly in it, and a loose-pages count first.
 *
 * A folder that only holds subfolders reports 0, which is what makes the line
 * read as structure rather than as content.
 */
function outline(paths: string[]): string[] {
  const directCount = new Map<string, number>();
  let topLevel = 0;
  for (const path of paths) {
    const folder: string = folderOf(path);
    if (folder === "") topLevel += 1;
    else directCount.set(folder, (directCount.get(folder) ?? 0) + 1);
  }

  const out: string[] = [];
  if (topLevel > 0) out.push(`  - (${topLevel} top-level pages)`);
  for (const folder of distinctFolders(paths)) {
    out.push(
      `  ${"  ".repeat(folderDepth(folder))}- ${flatten(folder)} ` +
        `(${directCount.get(folder) ?? 0} pages)`,
    );
  }
  return out;
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
