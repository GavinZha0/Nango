/**
 * Turning imported page text into the one-line description an agent sees.
 *
 * A folder of notes carries its summaries inside the files, so an import has
 * something better to put in `kb_page.description` than NULL: the first prose
 * paragraph. `list_kb_pages` prints that line, and a directory's `README` /
 * `index` page is the prose a folder's whole subtree is standing in for — which
 * is why folders themselves carry no description field.
 *
 * Deliberately free of `server-only` so the derivation is testable on its own.
 * See docs/kb.md.
 */

import type { KbContentType } from "@/lib/db/schema";
import { MAX_DESCRIPTION_CHARS } from "@/lib/kb/limits";

/** Only prose files describe themselves; a CSV header row is data, not a summary. */
const PROSE_CONTENT_TYPES: readonly KbContentType[] = [
  "text/markdown",
  "text/plain",
];

const FRONT_MATTER_FENCE = /^---$/;
const ATX_HEADING = /^#{1,6}\s/;
/** A line of dashes or stars is a rule, not a sentence. */
const HORIZONTAL_RULE = /^[-*_]{3,}$/;

function isSkippable(line: string): boolean {
  return ATX_HEADING.test(line) || HORIZONTAL_RULE.test(line);
}

/** The first block of prose lines after any front matter; null when there is none. */
function firstParagraph(content: string): string | null {
  const lines: string[] = content.split(/\r?\n/);
  let cursor = 0;
  if (lines[0]?.trim() === "---") {
    const closing: number = lines.findIndex(
      (line, index) => index > 0 && FRONT_MATTER_FENCE.test(line.trim()),
    );
    if (closing > 0) cursor = closing + 1;
  }

  const paragraph: string[] = [];
  for (; cursor < lines.length; cursor += 1) {
    const line: string = lines[cursor].trim();
    if (line === "" || isSkippable(line)) {
      // A blank or heading ends the paragraph once it has started; before that,
      // it is the page's title and front matter scrolling past.
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }

  const text: string = paragraph.join(" ").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** Cut on a word boundary so the truncated line still reads as a sentence. */
function fitDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const head: string = text.slice(0, MAX_DESCRIPTION_CHARS - 1);
  const lastSpace: number = head.lastIndexOf(" ");
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

/**
 * The description an imported page gets from its own body, or null when the file
 * is data rather than prose, or holds no paragraph at all.
 */
export function derivePageDescription(
  content: string,
  contentType: KbContentType,
): string | null {
  if (!PROSE_CONTENT_TYPES.includes(contentType)) return null;
  const paragraph: string | null = firstParagraph(content);
  return paragraph === null ? null : fitDescription(paragraph);
}
