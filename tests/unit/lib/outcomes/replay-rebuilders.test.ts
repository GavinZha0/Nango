import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  rebuildChartOutcome,
  rebuildWebSearchOutcome,
  tryDomain,
  type RebuildContext,
  type ToolCallChunkPayload,
  type ToolCallResultPayload,
} from "@/lib/outcomes/replay-rebuilders";

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
        chart_id: "sales-pie",
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
        chart_id: "no-dataset-bar",
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
        args: JSON.stringify({ chart_id: "c", title: "t" }),
      },
      ctxFixture(),
    );
    expect(built).toBeNull();
  });

  it("skips silently when chart_id or title missing (defensive)", () => {
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
          chart_id: "c",
          option: { series: [{ type: "bar" }] },
        }),
      },
      ctxFixture(),
    );
    expect(noTitle).toBeNull();
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
