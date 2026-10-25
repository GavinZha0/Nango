/**
 * Code constants for knowledge-base authoring limits.
 *
 * These are deliberately NOT config keys: they bound a single authored string on
 * a resource the operator also writes, so tuning them would mean re-tuning the
 * corpus afterwards. Prompt size is protected by the structural caps instead —
 * see docs/kb.md.
 */

/** Upper bound on one `description` at any level (collection, group, page). */
export const MAX_DESCRIPTION_CHARS = 512;

/**
 * Lower bound for collection and group descriptions, which are injected
 * verbatim into every bound agent's prompt. A short-but-present one renders as
 * a confident routing line that routes nowhere, so it is refused at the write
 * edge. Page descriptions are optional and exempt.
 */
export const MIN_DESCRIPTION_CHARS = 10;

/**
 * Upper bound for the remaining short authored strings: group and page `name`,
 * and a page's `source_ref` note. Page `name` is the handle an agent passes to
 * `read_kb_page`, so it is prompt-visible; a 200-character one is already
 * unusable, and nothing legitimate needs more.
 */
export const MAX_LABEL_CHARS = 200;

/**
 * Group levels below a collection. The runtime index, the tree UI and the
 * service's move checks all state this number, so it lives beside the other
 * authored-structure constants rather than inside the server-only budget file.
 */
export const MAX_GROUP_DEPTH = 2;
