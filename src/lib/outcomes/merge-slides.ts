/**
 * Pure helper functions for merging Bento Slides JSON documents.
 * Shared across client preview card, server replay rebuilders, and artifact saving.
 */

/**
 * Merge an incoming Bento slides document into a base document.
 * - Preserves the base document's global metadata (title, size, theme, transitions).
 * - Deduplicates and re-indexes slide IDs to prevent navigation & morph conflicts.
 */
export function mergeSlideDocs(
  baseDoc: Record<string, unknown>,
  incomingDoc: Record<string, unknown>,
): Record<string, unknown> {
  const existingSlides = Array.isArray(baseDoc.slides)
    ? (baseDoc.slides as Array<Record<string, unknown>>)
    : [];
  const incomingSlides = Array.isArray(incomingDoc.slides)
    ? (incomingDoc.slides as Array<Record<string, unknown>>)
    : [];

  const existingIds = new Set(existingSlides.map((s) => String(s?.id ?? "")));
  const deduplicatedIncoming = incomingSlides.map((s, idx) => {
    if (!s || typeof s !== "object") return s;
    const rawId = String(s.id ?? "");
    if (!s.id || existingIds.has(rawId)) {
      return {
        ...s,
        id: `${rawId || "slide"}-p${existingSlides.length + idx + 1}`,
      };
    }
    return s;
  });

  return {
    ...incomingDoc,
    ...baseDoc,
    slides: [...existingSlides, ...deduplicatedIncoming],
  };
}

/**
 * Merge an ordered chain of Bento slides documents (e.g. from multiple append calls).
 * The first item in the chain serves as the base metadata provider.
 */
export function mergeSlideDocChain(
  chain: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (chain.length === 0) return null;
  if (chain.length === 1) return chain[0]!;

  let current = chain[0]!;
  for (let i = 1; i < chain.length; i++) {
    current = mergeSlideDocs(current, chain[i]!);
  }
  return current;
}
