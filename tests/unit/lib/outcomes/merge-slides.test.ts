import { describe, expect, it } from "vitest";
import { mergeSlideDocs, mergeSlideDocChain } from "@/lib/outcomes/merge-slides";

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

  it("deduplicates colliding slide IDs from incoming doc", () => {
    const base = {
      slides: [{ id: "slide-1" }, { id: "slide-2" }],
    };
    const incoming = {
      slides: [{ id: "slide-1" }, { id: "slide-new" }], // slide-1 collides!
    };

    const merged = mergeSlideDocs(base, incoming);
    const slides = merged.slides as Array<{ id: string }>;

    expect(slides).toHaveLength(4);
    expect(slides[0]?.id).toBe("slide-1");
    expect(slides[1]?.id).toBe("slide-2");
    expect(slides[2]?.id).toBe("slide-1-p3"); // Renamed with unique suffix
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
