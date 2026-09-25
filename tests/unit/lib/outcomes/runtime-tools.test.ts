import { describe, expect, it } from "vitest";
import {
  buildGenerateBentoSlidesTool,
} from "@/lib/outcomes/runtime-tools";
import {
  buildBentoSlidesPromptBlock,
  buildChartPromptBlock,
  buildHtmlPagePromptBlock,
} from "@/lib/outcomes/prompt-block.server";
import type {
  GenerateBentoSlidesArgs,
  GenerateBentoSlidesResult,
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
});

describe("prompt blocks", () => {
  it("buildBentoSlidesPromptBlock contains usage guidelines", () => {
    const block = buildBentoSlidesPromptBlock();
    expect(block).toContain("## generate_bento_slides usage");
    expect(block).toContain("bento/slides");
    expect(block).toContain("1280x720");
    expect(block).toContain("charts-lite");
    expect(block).toContain("outcome_id");
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
