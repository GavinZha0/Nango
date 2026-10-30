/**
 * Config-backed KB budgets.
 *
 * Byte and count ceilings are operator tunables (Admin → Config, `kb.` prefix);
 * the authored-string caps beside them are code constants in
 * `src/lib/kb/limits.ts`. See docs/kb.md.
 */

import "server-only";

import { getConfigNumber } from "@/lib/config";

/** Stored bytes for one page's `content`. */
export const PAGE_MAX_BYTES = (): number =>
  getConfigNumber("kb.page_max_bytes", 256 * 1024);

/** Pages per collection. */
export const MAX_PAGES_PER_COLLECTION = (): number =>
  getConfigNumber("kb.max_pages", 50);

/**
 * Folders per collection — the distinct path prefixes the pages imply. Also the
 * ceiling on how many index lines a mounted collection injects into every bound
 * agent's prompt — there is no separate mount byte budget.
 */
export const MAX_FOLDERS_PER_COLLECTION = (): number =>
  getConfigNumber("kb.max_folders", 20);

/**
 * Returned bytes for one `read_kb_page` call. The page itself may be stored
 * larger (`PAGE_MAX_BYTES`), so this is a context-flooding guard, not a write
 * limit — the stored-vs-returned pair beside `host.file.write_max_bytes` /
 * `host.file.read_max_bytes`.
 *
 * Zero, negative or fractional values are a mis-configuration, not a mode, so
 * the budget floors at whole bytes with a floor of 1: an unfloored budget
 * breaks the window loop before it consumes a line, and the agent then pages
 * on a `nextOffset` equal to its own `offset` forever. Same floor as
 * `host.file.read_max_bytes`.
 */
export const READ_MAX_BYTES = (): number =>
  Math.max(1, Math.floor(getConfigNumber("kb.read_max_bytes", 64 * 1024)));
