/**
 * Code constants for knowledge-base authoring limits.
 *
 * These are deliberately NOT config keys: they bound a single authored string on
 * a resource the operator also writes, so tuning them would mean re-tuning the
 * corpus afterwards. Prompt size is protected by the structural caps instead —
 * see docs/kb.md.
 */

/** Upper bound on one `description` (collection or page). */
export const MAX_DESCRIPTION_CHARS = 512;

/**
 * Lower bound for the collection description, which is injected verbatim into
 * every bound agent's prompt. A short-but-present one renders as a confident
 * routing line that routes nowhere, so it is refused at the write edge. Page
 * descriptions are optional and exempt.
 */
export const MIN_DESCRIPTION_CHARS = 10;

/** Upper bound on a page's free-form `source_ref` maintenance note. */
export const MAX_LABEL_CHARS = 200;

/**
 * Upper bound on one page `path`, which is also the agent's handle for the page.
 *
 * Deliberately the same ceiling the folder-import transport puts on a manifest
 * path (`IMPORT_PATH_MAX_CHARS`): a corpus imported from a folder must never
 * overflow the storage rule it lands in.
 */
export const MAX_PATH_CHARS = 256;

/**
 * Folder levels below a collection, so a page path is at most this plus one
 * segments. The runtime index, the tree UI and the service's path checks all
 * state this number, so it lives beside the other authored-structure constants
 * rather than inside the server-only budget file.
 */
export const MAX_FOLDER_DEPTH = 2;
