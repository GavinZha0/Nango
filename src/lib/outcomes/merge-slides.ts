/**
 * Pure helper functions for merging Bento Slides JSON documents.
 * Shared across client preview card, server replay rebuilders, and artifact saving.
 */


export type SlideEditAction = "delete" | "replace" | "insert";

export interface SlideEditOperation {
  action: SlideEditAction;
  target_slide_ids?: string[];
  slides?: Array<Record<string, unknown>>;
}

export interface SlideEditResult {
  doc: Record<string, unknown>;
  changed: boolean;
}

/**
 * Apply a delta edit operation (delete, replace, or insert) to a Bento slides document.
 *
 * PURE REDUCER — shared across client outcome-store, server replay rebuilders,
 * and artifact save pipelines.
 *
 * Returns `{ doc, changed }` to explicitly signal whether any modifications occurred,
 * allowing stores and replay engines to defer or buffer out-of-order edits.
 */
export function applySlideEdit(
  baseDoc: Record<string, unknown>,
  operation: SlideEditOperation,
): SlideEditResult {
  const existingSlides = Array.isArray(baseDoc.slides)
    ? (baseDoc.slides as Array<Record<string, unknown>>)
    : [];

  const targetIds = operation.target_slide_ids ?? [];
  const incomingSlides = Array.isArray(operation.slides)
    ? (operation.slides as Array<Record<string, unknown>>)
    : [];

  switch (operation.action) {
    case "delete": {
      if (targetIds.length === 0) return { doc: baseDoc, changed: false };
      const toDelete = new Set(targetIds.map((id) => String(id)));
      const remaining = existingSlides.filter(
        (s) => !toDelete.has(String(s?.id ?? "")),
      );
      // No targets matched in existing slides
      if (remaining.length === existingSlides.length) {
        return { doc: baseDoc, changed: false };
      }
      // CONTRACT: Must retain at least 1 slide. Prevent deleting the entire deck.
      if (remaining.length === 0) {
        return { doc: baseDoc, changed: false };
      }
      return {
        doc: {
          ...baseDoc,
          slides: remaining,
        },
        changed: true,
      };
    }

    case "replace": {
      if (targetIds.length === 0 || incomingSlides.length === 0) {
        return { doc: baseDoc, changed: false };
      }
      const replaceMap = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < targetIds.length; i++) {
        const targetId = String(targetIds[i]);
        const replacement = incomingSlides[i];
        if (replacement && typeof replacement === "object") {
          // CONTRACT: Slide ID immutability — replace retains the target id.
          replaceMap.set(targetId, {
            ...replacement,
            id: targetId,
          });
        }
      }

      let matchedCount = 0;
      const updated = existingSlides.map((s) => {
        const id = String(s?.id ?? "");
        if (replaceMap.has(id)) {
          matchedCount++;
          return replaceMap.get(id)!;
        }
        return s;
      });

      if (matchedCount === 0) {
        return { doc: baseDoc, changed: false };
      }

      return {
        doc: {
          ...baseDoc,
          slides: updated,
        },
        changed: true,
      };
    }

    case "insert": {
      const normalizedIncoming = incomingSlides.filter(
        (s): s is Record<string, unknown> =>
          Boolean(s && typeof s === "object"),
      );
      if (normalizedIncoming.length === 0) {
        return { doc: baseDoc, changed: false };
      }

      // Positioning logic:
      // 1. target_slide_ids empty/omitted -> append at end
      // 2. target_slide_ids[0] === '0' -> insert at start (index 0)
      // 3. target_slide_ids[0] matches slide -> insert after that slide
      // 4. anchor not found -> fallback to append at end
      let insertIndex = existingSlides.length;
      if (targetIds.length > 0 && targetIds[0] !== undefined) {
        const anchor = String(targetIds[0]);
        if (anchor === "0") {
          insertIndex = 0;
        } else {
          const foundIdx = existingSlides.findIndex(
            (s) => String(s?.id ?? "") === anchor,
          );
          if (foundIdx !== -1) {
            insertIndex = foundIdx + 1;
          }
        }
      }

      const updated = [
        ...existingSlides.slice(0, insertIndex),
        ...normalizedIncoming,
        ...existingSlides.slice(insertIndex),
      ];

      return {
        doc: {
          ...baseDoc,
          slides: updated,
        },
        changed: true,
      };
    }

    default:
      return { doc: baseDoc, changed: false };
  }
}

