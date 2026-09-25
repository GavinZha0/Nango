import { describe, expect, it } from "vitest";
import {
  buildGenerateBentoSlidesTool,
  buildEditBentoSlidesTool,
} from "@/lib/outcomes/runtime-tools";
import {
  buildBentoSlidesPromptBlock,
  buildChartPromptBlock,
  buildHtmlPagePromptBlock,
} from "@/lib/outcomes/prompt-block.server";
import {
  editBentoSlidesSchema,
  type GenerateBentoSlidesArgs,
  type GenerateBentoSlidesResult,
  type EditBentoSlidesArgs,
  type EditBentoSlidesResult,
} from "@/lib/outcomes/schema";

describe("buildGenerateBentoSlidesTool", () => {
  const tool = buildGenerateBentoSlidesTool();
  const execute = tool.execute as (
    args: GenerateBentoSlidesArgs,
  ) => Promise<GenerateBentoSlidesResult>;

  it("has correct tool name and description", () => {
    expect(tool.name).toBe("generate_bento_slides");
    expect(tool.description).toContain("Bento");
    expect(tool.description).toContain("1280x720");
  });

  it("successfully validates and echoes valid bento slides", async () => {
    const validDoc = {
      format: "bento/slides",
      slides: [
        {
          id: "slide-1",
          elements: [{ type: "text", content: "Hello World" }],
        },
      ],
    };

    const result = await execute({
      outcome_id: "my-deck",
      title: "My Presentation",
      description: "Introductory deck",
      doc: validDoc,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome_id).toBe("my-deck");
      expect(result.title).toBe("My Presentation");
      expect(result.description).toBe("Introductory deck");
      expect(result.doc).toEqual(validDoc);
    }
  });

  it("normalizes outcome_id", async () => {
    const validDoc = {
      format: "bento/slides",
      slides: [{ id: "slide-1" }],
    };

    const result = await execute({
      outcome_id: "My First Deck!",
      title: "Deck Title",
      doc: validDoc,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome_id).toBe("my-first-deck");
      expect(result.message).toContain("normalized");
    }
  });

  it("fails when doc is too large (> 512KB)", async () => {
    const hugeSlides = Array.from({ length: 1000 }, (_, i) => ({
      id: `slide-${i}`,
      elements: [{ type: "text", content: "x".repeat(600) }],
    }));

    const result = await execute({
      outcome_id: "huge-deck",
      title: "Huge Deck",
      doc: {
        format: "bento/slides",
        slides: hugeSlides,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("DOC_TOO_LARGE");
      expect(result.message).toContain("cap is 524288");
    }
  });

  it("auto-normalizes doc.format and polyfills metadata when missing", async () => {
    const result = await execute({
      outcome_id: "no-format",
      title: "Auto Polyfill Deck",
      doc: {
        slides: [{ id: "s1", elements: [] }],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.format).toBe("bento/slides");
      expect(result.doc.version).toBe(1);
      expect(result.doc.title).toBe("Auto Polyfill Deck");
      expect(result.doc.size).toEqual({ width: 1280, height: 720 });
    }
  });

  it("auto-normalizes shorthand doc.format to 'bento/slides'", async () => {
    const result = await execute({
      outcome_id: "shorthand-format",
      title: "Shorthand Format",
      doc: {
        format: "slides",
        slides: [{ id: "s1", elements: [] }],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.format).toBe("bento/slides");
    }
  });

  it("fails when doc.slides is empty", async () => {
    const result = await execute({
      outcome_id: "empty-slides",
      title: "Empty Slides",
      doc: {
        format: "bento/slides",
        slides: [],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("DOC_NO_SLIDES");
    }
  });

  it("fails when slide is missing id or id is empty", async () => {
    const result = await execute({
      outcome_id: "missing-id-deck",
      title: "Missing ID",
      doc: {
        format: "bento/slides",
        slides: [{ elements: [] } as unknown as { id: string }],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("SLIDE_MISSING_ID");
    }
  });

  it("fails when slide has non-string or empty string id", async () => {
    const resNumber = await execute({
      outcome_id: "numeric-id-deck",
      title: "Numeric ID",
      doc: {
        format: "bento/slides",
        slides: [{ id: 42 } as unknown as { id: string }],
      },
    });
    expect(resNumber.ok).toBe(false);
    if (!resNumber.ok) {
      expect(resNumber.error).toBe("SLIDE_MISSING_ID");
    }

    const resEmpty = await execute({
      outcome_id: "empty-id-deck",
      title: "Empty String ID",
      doc: {
        format: "bento/slides",
        slides: [{ id: "" }],
      },
    });
    expect(resEmpty.ok).toBe(false);
    if (!resEmpty.ok) {
      expect(resEmpty.error).toBe("SLIDE_MISSING_ID");
    }
  });

  it("fails when slide IDs are duplicated within the deck", async () => {
    const result = await execute({
      outcome_id: "duplicate-id-deck",
      title: "Duplicate ID",
      doc: {
        format: "bento/slides",
        slides: [{ id: "slide-1" }, { id: "slide-1" }],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("DUPLICATE_SLIDE_ID");
    }
  });
});

describe("buildEditBentoSlidesTool", () => {
  const tool = buildEditBentoSlidesTool();
  const execute = tool.execute as (
    args: EditBentoSlidesArgs,
  ) => Promise<EditBentoSlidesResult>;

  it("has correct tool name and description", () => {
    expect(tool.name).toBe("edit_bento_slides");
    expect(tool.description).toContain("delete");
    expect(tool.description).toContain("replace");
    expect(tool.description).toContain("insert");
  });

  describe("action: delete", () => {
    it("validates successful delete call", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "delete",
        target_slide_ids: ["slide-1", "slide-2"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("delete");
        expect(result.target_slide_ids).toEqual(["slide-1", "slide-2"]);
      }
    });

    it("rejects delete with slides provided", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "delete",
        target_slide_ids: ["slide-1"],
        slides: [{ id: "unwanted-slide" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("UNEXPECTED_SLIDES");
      }
    });

    it("rejects delete without target_slide_ids", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "delete",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("TARGET_SLIDE_IDS_REQUIRED");
      }
    });
  });

  describe("action: replace", () => {
    it("validates successful replace call (ID immutability enforced at Reducer layer)", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "replace",
        target_slide_ids: ["slide-target"],
        slides: [{ id: "arbitrary-id-from-llm", title: "New Content" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("replace");
        // CONTRACT: ID immutability is enforced by applySlideEdit (Reducer layer),
        // not by the tool layer. The tool layer returns the LLM's original id.
        expect(result.slides?.[0]?.id).toBe("arbitrary-id-from-llm");
      }
    });

    it("rejects replace with count mismatch", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "replace",
        target_slide_ids: ["s1", "s2"],
        slides: [{ id: "only-one-slide" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("REPLACE_COUNT_MISMATCH");
      }
    });

    it("rejects replace with duplicate target_slide_ids", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "replace",
        target_slide_ids: ["s1", "s1"],
        slides: [{ id: "new-1" }, { id: "new-2" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("DUPLICATE_TARGET_SLIDE_ID");
      }
    });
  });

  describe("action: insert", () => {
    it("validates successful insert (default append when no targets)", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "insert",
        slides: [{ id: "new-slide-1" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("insert");
        expect(result.slides).toHaveLength(1);
      }
    });

    it("rejects insert without slides", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "insert",
        slides: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("SLIDES_REQUIRED");
      }
    });

    it("rejects insert when slide has missing id", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "insert",
        slides: [{ title: "No ID" } as unknown as { id: string }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("SLIDE_MISSING_ID");
      }
    });

    it("rejects insert when slide has non-string or empty string id", async () => {
      const resNum = await execute({
        outcome_id: "deck-1",
        action: "insert",
        slides: [{ id: 100 } as unknown as { id: string }],
      });
      expect(resNum.ok).toBe(false);
      if (!resNum.ok) {
        expect(resNum.error).toBe("SLIDE_MISSING_ID");
      }

      const resEmpty = await execute({
        outcome_id: "deck-1",
        action: "insert",
        slides: [{ id: "" }],
      });
      expect(resEmpty.ok).toBe(false);
      if (!resEmpty.ok) {
        expect(resEmpty.error).toBe("SLIDE_MISSING_ID");
      }
    });

    it("rejects insert when slide IDs are duplicated in batch", async () => {
      const result = await execute({
        outcome_id: "deck-1",
        action: "insert",
        slides: [{ id: "same-id" }, { id: "same-id" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("DUPLICATE_SLIDE_ID");
      }
    });

    it("accepts string-encoded JSON arrays via schema preprocessor", async () => {
      const parsedArgs = editBentoSlidesSchema.parse({
        outcome_id: "deck-preprocess",
        action: "insert",
        slides: JSON.stringify([{ id: "s-preprocess", title: "Preprocessed Slide" }]),
      });

      expect(Array.isArray(parsedArgs.slides)).toBe(true);
      expect(parsedArgs.slides).toHaveLength(1);
      expect(parsedArgs.slides?.[0]?.id).toBe("s-preprocess");

      const result = await execute(parsedArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.slides?.[0]?.id).toBe("s-preprocess");
      }
    });
  });
});

describe("prompt blocks", () => {
  it("buildBentoSlidesPromptBlock contains usage guidelines", () => {
    const block = buildBentoSlidesPromptBlock();
    expect(block).toContain("## generate_bento_slides usage");
    expect(block).toContain("bento/slides");
    expect(block).toContain("1280x720");
    expect(block).toContain("charts-lite");
    expect(block).toContain("outcome_id");
    expect(block).toContain("edit_bento_slides");
    expect(block).toContain("Incremental Generation");
  });

  it("buildHtmlPagePromptBlock contains usage guidelines", () => {
    const block = buildHtmlPagePromptBlock();
    expect(block).toContain("## generate_html_page usage");
    expect(block).toContain("outcome_id");
  });

  it("buildChartPromptBlock contains usage guidelines", () => {
    const block = buildChartPromptBlock({ hasDataSource: false, hasSandbox: false });
    expect(block).toContain("## generate_echarts_config usage");
  });
});
