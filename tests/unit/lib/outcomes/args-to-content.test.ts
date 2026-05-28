import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  chartArgsToContent,
  coerceChartOption,
  readRenderChartArgs,
} from "@/lib/outcomes/args-to-content";

describe("coerceChartOption", () => {
  it("uses `option` directly when it's an object", () => {
    const option = { xAxis: { type: "category" } };
    expect(coerceChartOption({ chartId: "c", title: "t", option })).toEqual(
      option,
    );
  });

  it("parses `optionJson` when `option` is absent", () => {
    expect(
      coerceChartOption({
        chartId: "c",
        title: "t",
        optionJson: '{"series":[{"type":"line"}]}',
      }),
    ).toEqual({ series: [{ type: "line" }] });
  });

  it("prefers `option` over `optionJson` when both are set", () => {
    // V1.0 → V1.3 transitional rows can carry both; the parsed
    // object form wins because it's already the renderer's
    // expected shape (no parse cost, no risk of legacy strings).
    expect(
      coerceChartOption({
        chartId: "c",
        title: "t",
        option: { fromObject: true },
        optionJson: '{"fromString":true}',
      }),
    ).toEqual({ fromObject: true });
  });

  it("returns null when `optionJson` is not valid JSON", () => {
    expect(
      coerceChartOption({
        chartId: "c",
        title: "t",
        optionJson: "{not-json",
      }),
    ).toBeNull();
  });

  it("returns null when neither field is usable", () => {
    expect(coerceChartOption({ chartId: "c", title: "t" })).toBeNull();
    expect(
      coerceChartOption({ chartId: "c", title: "t", optionJson: "" }),
    ).toBeNull();
    // Arrays / primitives are rejected — the renderer needs a
    // Record<string, unknown>.
    expect(
      coerceChartOption({
        chartId: "c",
        title: "t",
        optionJson: "[1,2,3]",
      }),
    ).toBeNull();
  });
});

describe("chartArgsToContent", () => {
  it("wraps the parsed option in a single ChartBlock", () => {
    const content = chartArgsToContent({
      chartId: "trend-2025-01-27",
      title: "Trend",
      optionJson: '{"series":[{"type":"bar"}]}',
    });
    expect(content).toEqual({
      blocks: [{ kind: "chart", option: { series: [{ type: "bar" }] } }],
    });
  });

  it("propagates `datasetName` onto the block when present", () => {
    const content = chartArgsToContent({
      chartId: "trend",
      title: "Trend",
      option: { xAxis: { type: "value" } },
      datasetName: "orders-q4",
    });
    expect(content?.blocks[0]).toMatchObject({
      kind: "chart",
      datasetName: "orders-q4",
    });
  });

  it("omits `datasetName` from the block when args don't supply it", () => {
    const content = chartArgsToContent({
      chartId: "trend",
      title: "Trend",
      option: {},
    });
    expect(content?.blocks[0]).not.toHaveProperty("datasetName");
  });

  it("returns null when no option is recoverable", () => {
    expect(
      chartArgsToContent({ chartId: "trend", title: "Trend" }),
    ).toBeNull();
  });
});

describe("readRenderChartArgs", () => {
  it("returns a typed copy of valid args", () => {
    const raw: Record<string, unknown> = {
      chartId: "trend",
      title: "Trend",
      description: "weekly latency",
      optionJson: "{}",
      datasetName: "orders",
    };
    expect(readRenderChartArgs(raw)).toEqual({
      chartId: "trend",
      title: "Trend",
      description: "weekly latency",
      optionJson: "{}",
      datasetName: "orders",
    });
  });

  it("rejects when required fields are missing or wrong-typed", () => {
    expect(readRenderChartArgs({ title: "t" })).toBeNull();
    expect(readRenderChartArgs({ chartId: "c" })).toBeNull();
    expect(readRenderChartArgs({ chartId: "", title: "t" })).toBeNull();
    expect(readRenderChartArgs({ chartId: "c", title: 42 })).toBeNull();
  });

  it("accepts object-form `option` and ignores non-object values", () => {
    expect(
      readRenderChartArgs({
        chartId: "c",
        title: "t",
        option: { a: 1 },
      })?.option,
    ).toEqual({ a: 1 });
    // Arrays / null shouldn't surface as option.
    expect(
      readRenderChartArgs({ chartId: "c", title: "t", option: [1] })?.option,
    ).toBeUndefined();
    expect(
      readRenderChartArgs({ chartId: "c", title: "t", option: null })?.option,
    ).toBeUndefined();
  });
});
