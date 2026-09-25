import { describe, it, expect, vi } from "vitest";

import {
  rebuildChartOutcome,
  rebuildBentoSlidesOutcome,
  rebuildBentoSlideEditOutcome,
  rebuildWebSearchOutcome,
  tryDomain,
  type RebuildContext,
  type ToolCallChunkPayload,
  type ToolCallResultPayload,
} from "@/lib/outcomes/replay-rebuilders";
import type { SlideBlock } from "@/store/outcome-store";

function ctxFixture(): RebuildContext {
  return {
    threadId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    runId: "run-1",
    entityId: "agent-1",
    ts: new Date("2025-04-01T10:00:00Z"),
    log: { warn: vi.fn() },
  };
}

describe("rebuildChartOutcome", () => {
  it("rebuilds a Report with a single chart block from generate_echarts_config args", () => {
    const chunk: ToolCallChunkPayload = {
      toolCallId: "call-1",
      toolName: "generate_echarts_config",
      args: JSON.stringify({
        outcome_id: "sales-pie",
        title: "Q1 Sales",
        description: "Top regions",
        option: {
          series: [{ type: "pie", data: [{ name: "A", value: 1 }] }],
        },
        dataset_id: "sales_q1",
      }),
    };
    const built = rebuildChartOutcome(chunk, ctxFixture());
    expect(built).not.toBeNull();
    expect(built!.id).toBe("sales-pie");
    expect(built!.outcome.outcomeId).toBe("sales-pie");
    expect(built!.outcome.kind).toBe("report");
    expect(built!.outcome.title).toBe("Q1 Sales");
    expect(built!.outcome.blocks).toHaveLength(1);
    expect(built!.outcome.blocks[0].kind).toBe("chart");
    if (built!.outcome.blocks[0].kind === "chart") {
      expect(built!.outcome.blocks[0].datasetName).toBe("sales_q1");
      expect(built!.outcome.blocks[0].option).toEqual({
        series: [{ type: "pie", data: [{ name: "A", value: 1 }] }],
      });
    }
    expect(built!.outcome.collapsed).toBe(false);
  });

  it("rebuilds without dataset_id when none supplied", () => {
    const chunk: ToolCallChunkPayload = {
      toolCallId: "call-2",
      toolName: "generate_echarts_config",
      args: JSON.stringify({
        outcome_id: "no-dataset-bar",
        title: "No-dataset Bar",
        option: { series: [{ type: "bar" }] },
      }),
    };
    const built = rebuildChartOutcome(chunk, ctxFixture());
    expect(built).not.toBeNull();
    expect(built!.outcome.blocks[0].kind).toBe("chart");
    if (built!.outcome.blocks[0].kind === "chart") {
      expect(built!.outcome.blocks[0].datasetName).toBeUndefined();
      expect(built!.outcome.blocks[0].option).toEqual({
        series: [{ type: "bar" }],
      });
    }
  });

  it("returns null and warns on unparseable args JSON", () => {
    const ctx = ctxFixture();
    const built = rebuildChartOutcome(
      {
        toolCallId: "x",
        toolName: "generate_echarts_config",
        args: "{ this is not json",
      },
      ctx,
    );
    expect(built).toBeNull();
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("returns null when option is missing", () => {
    const built = rebuildChartOutcome(
      {
        toolCallId: "x",
        toolName: "generate_echarts_config",
        args: JSON.stringify({ outcome_id: "c", title: "t" }),
      },
      ctxFixture(),
    );
    expect(built).toBeNull();
  });

  it("skips silently when outcome_id or title missing (defensive)", () => {
    const noChartId = rebuildChartOutcome(
      {
        toolCallId: "x",
        toolName: "generate_echarts_config",
        args: JSON.stringify({
          title: "t",
          option: { series: [{ type: "bar" }] },
        }),
      },
      ctxFixture(),
    );
    expect(noChartId).toBeNull();

    const noTitle = rebuildChartOutcome(
      {
        toolCallId: "x",
        toolName: "generate_echarts_config",
        args: JSON.stringify({
          outcome_id: "c",
          option: { series: [{ type: "bar" }] },
        }),
      },
      ctxFixture(),
    );
    expect(noTitle).toBeNull();
  });
});

describe("rebuildBentoSlidesOutcome", () => {
  it("rebuilds a Report with a single slide block from generate_bento_slides args", () => {
    const doc = {
      format: "bento/slides",
      slides: [{ id: "slide-1", elements: [{ type: "text", content: "Hi" }] }],
    };
    const chunk: ToolCallChunkPayload = {
      toolCallId: "call-slides-1",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "demo-deck",
        title: "Demo Deck",
        description: "Deck description",
        doc,
      }),
    };
    const built = rebuildBentoSlidesOutcome(chunk, ctxFixture());
    expect(built).not.toBeNull();
    expect(built!.id).toBe("demo-deck");
    expect(built!.outcome.outcomeId).toBe("demo-deck");
    expect(built!.outcome.kind).toBe("report");
    expect(built!.outcome.title).toBe("Demo Deck");
    expect(built!.outcome.blocks).toHaveLength(1);
    expect(built!.outcome.blocks[0].kind).toBe("slide");
    if (built!.outcome.blocks[0].kind === "slide") {
      expect(built!.outcome.blocks[0].doc).toEqual(doc);
    }
  });

  it("normalizes outcome_id during rebuild", () => {
    const chunk: ToolCallChunkPayload = {
      toolCallId: "call-slides-2",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "My Fancy Deck!",
        title: "Deck Title",
        doc: { format: "bento/slides", slides: [] },
      }),
    };
    const built = rebuildBentoSlidesOutcome(chunk, ctxFixture());
    expect(built).not.toBeNull();
    expect(built!.id).toBe("my-fancy-deck");
    expect(built!.outcome.outcomeId).toBe("my-fancy-deck");
  });

  it("replaces slides when called again even if priorOutcome exists", () => {
    const chunk1: ToolCallChunkPayload = {
      toolCallId: "call-slides-chunk-1",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "replace-deck",
        title: "Old Deck",
        doc: {
          format: "bento/slides",
          slides: [{ id: "slide-old" }],
        },
      }),
    };
    const built1 = rebuildBentoSlidesOutcome(chunk1, ctxFixture());

    const chunk2: ToolCallChunkPayload = {
      toolCallId: "call-slides-chunk-2",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "replace-deck",
        title: "New Deck",
        doc: {
          format: "bento/slides",
          slides: [{ id: "slide-new" }],
        },
      }),
    };
    const built2 = rebuildBentoSlidesOutcome(chunk2, ctxFixture(), built1!.outcome);
    expect(built2).not.toBeNull();
    const slideBlock = built2!.outcome.blocks[0];
    if (slideBlock.kind === "slide") {
      const slides = slideBlock.doc.slides as Array<Record<string, unknown>>;
      expect(slides).toHaveLength(1);
      expect(slides[0]?.id).toBe("slide-new");
    }
  });

  it("is idempotent when the same toolCallId is replayed twice", () => {
    const chunk1: ToolCallChunkPayload = {
      toolCallId: "call-slides-1",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "idempotent-deck",
        title: "Main Presentation Title",
        doc: {
          format: "bento/slides",
          slides: [{ id: "slide-1" }],
        },
      }),
    };
    const built1 = rebuildBentoSlidesOutcome(chunk1, ctxFixture());
    expect(built1).not.toBeNull();

    // Replay chunk1 again (same toolCallId)
    const built1Again = rebuildBentoSlidesOutcome(chunk1, ctxFixture(), built1!.outcome);
    expect(built1Again).not.toBeNull();
    expect(built1Again!.outcome).toBe(built1!.outcome);
  });

  it("returns null when result.ok is false (DOC_TOO_LARGE, etc.)", () => {
    const ctx = ctxFixture();
    const chunk: ToolCallChunkPayload = {
      toolCallId: "call-fail",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "failed-deck",
        title: "Failed Deck",
        doc: {
          format: "bento/slides",
          slides: [{ id: "slide-1" }],
        },
      }),
    };
    const errResult: ToolCallResultPayload = {
      toolCallId: "call-fail",
      content: JSON.stringify({
        ok: false,
        error: "DOC_TOO_LARGE",
        message: "Bento doc is 600000 bytes; cap is 524288.",
      }),
    };
    const built = rebuildBentoSlidesOutcome(chunk, ctx, undefined, errResult);
    expect(built).toBeNull();
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "outcomes_replay_tool_failed",
        tool: "generate_bento_slides",
        error: "DOC_TOO_LARGE",
      }),
      expect.any(String),
    );
  });

  it("falls back to chunk-only rebuild when result is missing (in-flight run)", () => {
    const chunk: ToolCallChunkPayload = {
      toolCallId: "call-inflight",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "inflight-deck",
        title: "In-flight Deck",
        doc: {
          format: "bento/slides",
          slides: [{ id: "slide-1" }],
        },
      }),
    };
    const built = rebuildBentoSlidesOutcome(chunk, ctxFixture(), undefined, undefined);
    expect(built).not.toBeNull();
    expect(built!.id).toBe("inflight-deck");
  });
});

describe("rebuildBentoSlideEditOutcome", () => {
  it("rebuilds deck after applying edit operations", () => {
    // 1. Initial deck
    const initChunk: ToolCallChunkPayload = {
      toolCallId: "call-init",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "deck-replay-edit",
        title: "Presentation Title",
        doc: {
          format: "bento/slides",
          slides: [
            { id: "s1", title: "Slide 1" },
            { id: "s2", title: "Slide 2" },
            { id: "s3", title: "Slide 3" },
          ],
        },
      }),
    };
    const initBuilt = rebuildBentoSlidesOutcome(initChunk, ctxFixture());
    expect(initBuilt).not.toBeNull();

    // 2. Edit call: delete s2
    const delChunk: ToolCallChunkPayload = {
      toolCallId: "call-del",
      toolName: "edit_bento_slides",
      args: JSON.stringify({
        outcome_id: "deck-replay-edit",
        action: "delete",
        target_slide_ids: ["s2"],
      }),
    };
    const delBuilt = rebuildBentoSlideEditOutcome(
      delChunk,
      ctxFixture(),
      initBuilt!.outcome,
    );
    const delBlock = delBuilt!.outcome.blocks[0] as SlideBlock;
    const delSlides = delBlock.doc.slides as Array<{ id: string }>;
    expect(delSlides.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(delBlock.appliedToolCallIds).toEqual(["call-init", "call-del"]);

    // 3. Duplicate del call (idempotent replay)
    const delDup = rebuildBentoSlideEditOutcome(
      delChunk,
      ctxFixture(),
      delBuilt!.outcome,
    );
    expect(delDup).not.toBeNull();
    const delDupBlock = delDup!.outcome.blocks[0] as SlideBlock;
    const delDupSlides = delDupBlock.doc.slides as Array<{ id: string }>;
    expect(delDupSlides.map((s) => s.id)).toEqual(["s1", "s3"]);

    // 4. Edit call: insert slide after s1
    const insChunk: ToolCallChunkPayload = {
      toolCallId: "call-ins",
      toolName: "edit_bento_slides",
      args: JSON.stringify({
        outcome_id: "deck-replay-edit",
        action: "insert",
        target_slide_ids: ["s1"],
        slides: [{ id: "s1-inserted", title: "Inserted Slide" }],
      }),
    };
    const insBuilt = rebuildBentoSlideEditOutcome(
      insChunk,
      ctxFixture(),
      delBuilt!.outcome,
    );
    expect(insBuilt).not.toBeNull();
    const insBlock = insBuilt!.outcome.blocks[0] as SlideBlock;
    const insSlides = insBlock.doc.slides as Array<{ id: string }>;
    expect(insSlides.map((s) => s.id)).toEqual([
      "s1",
      "s1-inserted",
      "s3",
    ]);
    expect(insBlock.appliedToolCallIds).toEqual([
      "call-init",
      "call-del",
      "call-ins",
    ]);
  });

  it("preserves outcome and does not record toolCallId when edit does not match", () => {
    const initChunk: ToolCallChunkPayload = {
      toolCallId: "call-init-nomatch",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "deck-nomatch",
        title: "Presentation",
        doc: {
          format: "bento/slides",
          slides: [{ id: "s1" }],
        },
      }),
    };
    const initBuilt = rebuildBentoSlidesOutcome(initChunk, ctxFixture());
    expect(initBuilt).not.toBeNull();

    const nomatchChunk: ToolCallChunkPayload = {
      toolCallId: "call-nomatch",
      toolName: "edit_bento_slides",
      args: JSON.stringify({
        outcome_id: "deck-nomatch",
        action: "delete",
        target_slide_ids: ["non-existent-id"],
      }),
    };
    const result = rebuildBentoSlideEditOutcome(
      nomatchChunk,
      ctxFixture(),
      initBuilt!.outcome,
    );
    expect(result).not.toBeNull();
    const block = result!.outcome.blocks[0] as SlideBlock;
    expect(block.appliedToolCallIds).toEqual(["call-init-nomatch"]);
    expect(block.appliedToolCallIds).not.toContain("call-nomatch");
  });

  it("returns priorOutcome when result.ok is false (REPLACE_COUNT_MISMATCH, etc.)", () => {
    const ctx = ctxFixture();
    const initChunk: ToolCallChunkPayload = {
      toolCallId: "call-init-editfail",
      toolName: "generate_bento_slides",
      args: JSON.stringify({
        outcome_id: "deck-editfail",
        title: "Deck",
        doc: {
          format: "bento/slides",
          slides: [{ id: "s1" }, { id: "s2" }],
        },
      }),
    };
    const initBuilt = rebuildBentoSlidesOutcome(initChunk, ctx);
    expect(initBuilt).not.toBeNull();

    const errChunk: ToolCallChunkPayload = {
      toolCallId: "call-edit-fail",
      toolName: "edit_bento_slides",
      args: JSON.stringify({
        outcome_id: "deck-editfail",
        action: "replace",
        target_slide_ids: ["s1"],
        slides: [{ title: "New Slide 1" }, { title: "Extra slide - mismatch" }],
      }),
    };
    const errResult: ToolCallResultPayload = {
      toolCallId: "call-edit-fail",
      content: JSON.stringify({
        ok: false,
        error: "REPLACE_COUNT_MISMATCH",
        message: "Action 'replace' requires exactly matching counts: received 2 slide(s) for 1 target id(s).",
      }),
    };
    const built = rebuildBentoSlideEditOutcome(
      errChunk,
      ctx,
      initBuilt!.outcome,
      errResult,
    );
    expect(built).not.toBeNull();
    const block = built!.outcome.blocks[0] as SlideBlock;
    expect(block.appliedToolCallIds).toEqual(["call-init-editfail"]);
    expect(block.appliedToolCallIds).not.toContain("call-edit-fail");
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "outcomes_replay_tool_failed",
        tool: "edit_bento_slides",
        error: "REPLACE_COUNT_MISMATCH",
      }),
      expect.any(String),
    );
  });
});

describe("rebuildWebSearchOutcome", () => {
  const okChunk: ToolCallChunkPayload = {
    toolCallId: "tc-abc",
    toolName: "web_search",
    args: JSON.stringify({ query: "openai news", topK: 5 }),
  };
  const okResult: ToolCallResultPayload = {
    toolCallId: "tc-abc",
    content: JSON.stringify({
      ok: true,
      provider: "exa",
      results: [
        {
          title: "OpenAI launches X",
          url: "https://openai.com/blog/x",
          snippet: "OpenAI today …",
          publishedAt: "2025-04-01",
          image: "https://cdn.example/hero.jpg",
          favicon: "https://openai.com/favicon.ico",
        },
        {
          title: "Analysis",
          url: "https://techcrunch.com/article",
          snippet: "Reporters …",
        },
      ],
    }),
  };

  it("pairs chunk + result, produces card_list with all fields", () => {
    const built = rebuildWebSearchOutcome(okChunk, okResult, ctxFixture());
    expect(built).not.toBeNull();
    expect(built!.id).toBe("tc-abc");
    expect(built!.outcome.outcomeId).toBe("tc-abc");
    expect(built!.outcome.kind).toBe("report");
    expect(built!.outcome.title).toBe("Search: openai news");
    expect(built!.outcome.description).toBe("2 results · via exa");
    expect(built!.outcome.blocks).toHaveLength(1);
    expect(built!.outcome.blocks[0].kind).toBe("card_list");
    if (built!.outcome.blocks[0].kind === "card_list") {
      expect(built!.outcome.blocks[0].cards).toHaveLength(2);
      const first = built!.outcome.blocks[0].cards[0];
      // Citation contract (P1g): 1-based index + sourceKind on every web result
      expect(first.index).toBe(1);
      expect(first.sourceKind).toBe("web");
      expect(first.title).toBe("OpenAI launches X");
      expect(first.url).toBe("https://openai.com/blog/x");
      expect(first.subtitle).toBe("openai.com"); // domain derived
      expect(first.snippet).toBe("OpenAI today …");
      expect(first.meta).toBe("2025-04-01");
      expect(first.image).toBe("https://cdn.example/hero.jpg");
      expect(first.favicon).toBe("https://openai.com/favicon.ico");
    }
    expect(built!.outcome.collapsed).toBe(false); // searches default-expanded
  });

  it("omits absent optional fields on each card but keeps citation fields", () => {
    const built = rebuildWebSearchOutcome(okChunk, okResult, ctxFixture());
    if (built!.outcome.blocks[0].kind !== "card_list") throw new Error();
    const second = built!.outcome.blocks[0].cards[1];
    // Citation fields populated even on items lacking image / favicon / meta
    expect(second.index).toBe(2);
    expect(second.sourceKind).toBe("web");
    expect(second.image).toBeUndefined();
    expect(second.favicon).toBeUndefined();
    expect(second.meta).toBeUndefined();
    expect(second.subtitle).toBe("techcrunch.com");
  });

  it("returns null when result is missing (in-flight crash)", () => {
    const built = rebuildWebSearchOutcome(okChunk, undefined, ctxFixture());
    expect(built).toBeNull();
  });

  it("returns null on error envelope (ok:false), no outcome card emitted", () => {
    const errResult: ToolCallResultPayload = {
      toolCallId: "tc-abc",
      content: JSON.stringify({
        ok: false,
        error: "UPSTREAM_HTTP",
        message: "Exa returned HTTP 401.",
      }),
    };
    const built = rebuildWebSearchOutcome(okChunk, errResult, ctxFixture());
    expect(built).toBeNull();
  });

  it("returns null and warns when args JSON is malformed", () => {
    const ctx = ctxFixture();
    const built = rebuildWebSearchOutcome(
      { toolCallId: "tc", toolName: "web_search", args: "{ broken" },
      okResult,
      ctx,
    );
    expect(built).toBeNull();
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("returns null and warns when result content is malformed", () => {
    const ctx = ctxFixture();
    const built = rebuildWebSearchOutcome(
      okChunk,
      { toolCallId: "tc-abc", content: "not-json" },
      ctx,
    );
    expect(built).toBeNull();
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("returns null when query is empty", () => {
    const built = rebuildWebSearchOutcome(
      { toolCallId: "tc", toolName: "web_search", args: JSON.stringify({}) },
      okResult,
      ctxFixture(),
    );
    expect(built).toBeNull();
  });
});

describe("tryDomain", () => {
  it("strips www. prefix", () => {
    expect(tryDomain("https://www.example.com/foo")).toBe("example.com");
  });

  it("returns hostname for plain URLs", () => {
    expect(tryDomain("https://news.example.com/path")).toBe("news.example.com");
  });

  it("returns empty string on garbage input", () => {
    expect(tryDomain("not a url")).toBe("");
  });

  it("handles localhost / port URLs", () => {
    expect(tryDomain("http://localhost:9300/")).toBe("localhost");
  });
});
