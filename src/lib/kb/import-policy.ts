/**
 * Knowledge-import policy: what a file in an imported folder becomes.
 *
 * A knowledge page is plain text read through `read_kb_page`, so the import is
 * text-only — an image has no column to live in and no agent path that renders
 * it. The noise/text/blocked lists are the shared {@link classifyFolderPath};
 * this module is the one difference on top of it, plus the two translations the
 * page row needs.
 *
 * Client-safe: the panel mirrors these rules before it uploads.
 */

import type { KbContentType } from "@/lib/db/schema";
import {
  classifyFolderPath,
  type FilePolicyResult,
} from "@/lib/folder-import/manifest";
import { guessContentType } from "@/lib/folder-import/mime";
import { KB_CONTENT_TYPES } from "@/lib/kb/validation";

/**
 * Classify a path entering a knowledge import: the shared rules, with an image
 * dropped instead of carried.
 *
 * The line between the two tiers is whether the file could have been a page. An
 * image never could — it is inline decoration that the prose references by name,
 * so it is skipped and reported like noise and the rest of the folder imports.
 * A `.pdf` or `.docx` is prose in a wrapper the product cannot read, so losing
 * one silently would hand the author a corpus missing the document they meant to
 * import: that stays `block`, which fails the upload and says convert it first.
 */
export function classifyKbImportPath(path: string): FilePolicyResult {
  const result: FilePolicyResult = classifyFolderPath(path);
  if (result.action === "allow-image") {
    return { action: "ignore" };
  }
  return result;
}

/**
 * The `content_type` parse hint for an imported file.
 *
 * `kb_page.content_type` is only a parse hint (docs/kb.md), so anything whose
 * MIME guess falls outside the CHECK set — a `.js` note, an extension-less
 * `README` — is stored as `text/plain` rather than dropped or rejected. The
 * mapping still comes from the shared table, so a new text extension needs one
 * edit, in `src/lib/folder-import/mime.ts`.
 */
export function kbContentType(path: string): KbContentType {
  const guess: string | null = guessContentType(path);
  return guess && (KB_CONTENT_TYPES as readonly string[]).includes(guess)
    ? (guess as KbContentType)
    : "text/plain";
}

/**
 * Why these bytes are not UTF-8 text; null when they are.
 *
 * `Buffer.toString("utf8")` silently substitutes U+FFFD for every invalid
 * sequence, turning a Latin-1 or GBK corpus into readable-looking garbage that
 * no agent can quote back correctly. Failing the import names the file instead.
 * (NUL bytes are already rejected by the walker.)
 */
export function textDecodeProblem(content: Uint8Array): string | null {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return null;
  } catch {
    return "not valid UTF-8 text; re-save it as UTF-8 and import again";
  }
}
