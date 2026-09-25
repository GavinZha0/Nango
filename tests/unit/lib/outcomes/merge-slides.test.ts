import { describe, expect, it } from "vitest";
import {
  mergeSlideDocs,
  mergeSlideDocChain,
  applySlideEdit,
} from "@/lib/outcomes/merge-slides";

describe("mergeSlideDocs", () => {
  it("merges slides from incoming doc into base doc", () => {
    const base = {
      format: "bento/slides",
      title: "Main Presentation",
      theme: { accent: "#ff0000" },
      slides: [{ id: "slide-1", content: "Part 1" }],
    };
    const incoming = {
      format: "bento/slides",
      title: "Batch 2",
      slides: [{ id: "slide-2", content: "Part 2" }],
    };

    const merged = mergeSlideDocs(base, incoming);

    expect(merged.format).toBe("bento/slides");
    expect(merged.title).toBe("Main Presentation"); // Preserves base title
    expect(merged.theme).toEqual({ accent: "#ff0000" }); // Preserves base theme
    const slides = merged.slides as Array<{ id: string; content: string }>;
    expect(slides).toHaveLength(2);
    expect(slides[0]).toEqual({ id: "slide-1", content: "Part 1" });
    expect(slides[1]).toEqual({ id: "slide-2", content: "Part 2" });
  });

  it("preserves slide IDs as immutable without silent renaming", () => {
    const base = {
      slides: [{ id: "slide-1" }, { id: "slide-2" }],
    };
    const incoming = {
      slides: [{ id: "slide-1" }, { id: "slide-new" }],
    };

    const merged = mergeSlideDocs(base, incoming);
    const slides = merged.slides as Array<{ id: string }>;

    expect(slides).toHaveLength(4);
    expect(slides[0]?.id).toBe("slide-1");
    expect(slides[1]?.id).toBe("slide-2");
    expect(slides[2]?.id).toBe("slide-1");
    expect(slides[3]?.id).toBe("slide-new");
  });

  it("handles missing or non-array slides gracefully", () => {
    const base = { title: "Deck without slides" };
    const incoming = { slides: [{ id: "slide-1" }] };

    const merged = mergeSlideDocs(base, incoming);
    const slides = merged.slides as Array<{ id: string }>;
    expect(slides).toHaveLength(1);
    expect(slides[0]?.id).toBe("slide-1");
  });
});

describe("mergeSlideDocChain", () => {
  it("returns null for empty chain", () => {
    expect(mergeSlideDocChain([])).toBeNull();
  });

  it("returns the single document when chain length is 1", () => {
    const single = { title: "Only One", slides: [{ id: "s-1" }] };
    expect(mergeSlideDocChain([single])).toBe(single);
  });

  it("merges multiple chunks in sequential order", () => {
    const chunk1 = { title: "Deck", slides: [{ id: "s-1" }] };
    const chunk2 = { title: "Batch 2", slides: [{ id: "s-2" }] };
    const chunk3 = { title: "Batch 3", slides: [{ id: "s-3" }] };

    const merged = mergeSlideDocChain([chunk1, chunk2, chunk3]);
    expect(merged).not.toBeNull();
    expect(merged!.title).toBe("Deck");
    const slides = merged!.slides as Array<{ id: string }>;
    expect(slides).toHaveLength(3);
    expect(slides.map((s) => s.id)).toEqual(["s-1", "s-2", "s-3"]);
  });
});

describe("applySlideEdit", () => {
  const baseDoc = {
    format: "bento/slides",
    title: "Company Deck",
    slides: [
      { id: "intro", title: "Introduction" },
      { id: "market", title: "Market Size" },
      { id: "product", title: "Product Features" },
      { id: "conclusion", title: "Conclusion" },
    ],
  };

  describe("action: delete", () => {
    it("deletes specified slides by target_slide_ids", () => {
      const result = applySlideEdit(baseDoc, {
        action: "delete",
        target_slide_ids: ["market", "product"],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides.map((s) => s.id)).toEqual(["intro", "conclusion"]);
    });

    it("leaves doc unchanged if target_slide_ids not found", () => {
      const result = applySlideEdit(baseDoc, {
        action: "delete",
        target_slide_ids: ["non-existent"],
      });
      expect(result.changed).toBe(false);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides).toHaveLength(4);
    });

    it("prevents deleting all slides (guard retains original deck)", () => {
      const result = applySlideEdit(baseDoc, {
        action: "delete",
        target_slide_ids: ["intro", "market", "product", "conclusion"],
      });
      expect(result.changed).toBe(false);
      const slides = result.doc.slides as Array<{ id: string }>;
      // Guard retains the original slides to prevent corrupting into empty deck
      expect(slides).toHaveLength(4);
    });
  });

  describe("action: replace", () => {
    it("replaces target slide and enforces ID immutability", () => {
      const result = applySlideEdit(baseDoc, {
        action: "replace",
        target_slide_ids: ["market"],
        slides: [{ id: "different-id-from-llm", title: "Updated Market Outlook" }],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string; title: string }>;
      expect(slides).toHaveLength(4);
      expect(slides[1]?.id).toBe("market"); // Enforces original target id!
      expect(slides[1]?.title).toBe("Updated Market Outlook");
    });

    it("replaces multiple slides in 1-to-1 order", () => {
      const result = applySlideEdit(baseDoc, {
        action: "replace",
        target_slide_ids: ["intro", "conclusion"],
        slides: [
          { title: "New Intro" },
          { title: "New Conclusion" },
        ],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string; title: string }>;
      expect(slides[0]?.id).toBe("intro");
      expect(slides[0]?.title).toBe("New Intro");
      expect(slides[3]?.id).toBe("conclusion");
      expect(slides[3]?.title).toBe("New Conclusion");
    });

    it("returns changed: false if replace targets do not exist", () => {
      const result = applySlideEdit(baseDoc, {
        action: "replace",
        target_slide_ids: ["unknown-id"],
        slides: [{ title: "Nobody to replace" }],
      });
      expect(result.changed).toBe(false);
    });
  });

  describe("action: insert", () => {
    it("appends to the end when target_slide_ids is omitted or empty", () => {
      const result = applySlideEdit(baseDoc, {
        action: "insert",
        slides: [{ id: "appendix", title: "Appendix" }],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides.map((s) => s.id)).toEqual([
        "intro",
        "market",
        "product",
        "conclusion",
        "appendix",
      ]);
    });

    it("inserts at start (index 0) when target_slide_ids[0] is '0'", () => {
      const result = applySlideEdit(baseDoc, {
        action: "insert",
        target_slide_ids: ["0"],
        slides: [{ id: "cover", title: "Cover Page" }],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides.map((s) => s.id)).toEqual([
        "cover",
        "intro",
        "market",
        "product",
        "conclusion",
      ]);
    });

    it("inserts after specific target slide id", () => {
      const result = applySlideEdit(baseDoc, {
        action: "insert",
        target_slide_ids: ["market"],
        slides: [{ id: "market-deep-dive", title: "Market Deep Dive" }],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides.map((s) => s.id)).toEqual([
        "intro",
        "market",
        "market-deep-dive",
        "product",
        "conclusion",
      ]);
    });

    it("fallbacks to appending to the end if anchor id is not found", () => {
      const result = applySlideEdit(baseDoc, {
        action: "insert",
        target_slide_ids: ["unknown-anchor"],
        slides: [{ id: "safe-insert", title: "Safe Insert" }],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides[slides.length - 1]?.id).toBe("safe-insert");
    });

    it("preserves incoming slide IDs as immutable without silent renaming", () => {
      const result = applySlideEdit(baseDoc, {
        action: "insert",
        target_slide_ids: ["intro"],
        slides: [{ id: "market", title: "Colliding Market" }],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides[1]?.id).toBe("market"); // keeps original id, no silent -p{idx} renaming
      expect(slides[2]?.id).toBe("market");
    });
  });

  describe("changed signal and referential stability", () => {
    it("returns changed: true on partial delete matches", () => {
      const result = applySlideEdit(baseDoc, {
        action: "delete",
        target_slide_ids: ["intro", "non-existent-id"],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string }>;
      expect(slides).toHaveLength(3);
      expect(slides.map((s) => s.id)).toEqual(["market", "product", "conclusion"]);
    });

    it("returns changed: false and same doc reference when delete matches nothing", () => {
      const result = applySlideEdit(baseDoc, {
        action: "delete",
        target_slide_ids: ["ghost-1", "ghost-2"],
      });
      expect(result.changed).toBe(false);
      expect(result.doc).toBe(baseDoc);
    });

    it("returns changed: true on partial replace matches", () => {
      const result = applySlideEdit(baseDoc, {
        action: "replace",
        target_slide_ids: ["product", "ghost-slide"],
        slides: [{ title: "New Product" }, { title: "Unmatched" }],
      });
      expect(result.changed).toBe(true);
      const slides = result.doc.slides as Array<{ id: string; title?: string }>;
      expect(slides.find((s) => s.id === "product")?.title).toBe("New Product");
    });

    it("returns changed: false and same doc reference when replace matches nothing", () => {
      const result = applySlideEdit(baseDoc, {
        action: "replace",
        target_slide_ids: ["ghost-1"],
        slides: [{ title: "Cannot Replace" }],
      });
      expect(result.changed).toBe(false);
      expect(result.doc).toBe(baseDoc);
    });

    it("returns changed: false and same doc reference when insert receives empty slides", () => {
      const result = applySlideEdit(baseDoc, {
        action: "insert",
        slides: [],
      });
      expect(result.changed).toBe(false);
      expect(result.doc).toBe(baseDoc);
    });
  });
});

