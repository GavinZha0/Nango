import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  chartArgsToContent,
  readGenerateEchartsConfigArgs,
} from "@/lib/outcomes/args-to-content";

describe("chartArgsToContent", () => {
  it("wraps the option object in a single ChartBlock", () => {
    const content = chartArgsToContent({
      chart_id: "trend-2025-01-27",
      title: "Trend",
      option: { series: [{ type: "bar" }] },
    });
    expect(content).toEqual({
      blocks: [{ kind: "chart", option: { series: [{ type: "bar" }] } }],
    });
  });

  it("propagates `dataset_id` onto the block as `datasetName` when present", () => {
    const content = chartArgsToContent({
      chart_id: "trend",
      title: "Trend",
      option: { xAxis: { type: "value" } },
      dataset_id: "orders-q4",
    });
    expect(content?.blocks[0]).toMatchObject({
      kind: "chart",
      datasetName: "orders-q4",
    });
  });

  it("omits `datasetName` from the block when args don't supply it", () => {
    const content = chartArgsToContent({
      chart_id: "trend",
      title: "Trend",
      option: {},
    });
    expect(content?.blocks[0]).not.toHaveProperty("datasetName");
  });

  it("returns null when option is not a plain object", () => {
    expect(
      chartArgsToContent({
        chart_id: "trend",
        title: "Trend",
        option: [1, 2, 3] as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
    expect(
      chartArgsToContent({
        chart_id: "trend",
        title: "Trend",
        option: null as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
  });
});

describe("readGenerateEchartsConfigArgs", () => {
  it("returns a typed copy of valid args", () => {
    const raw: Record<string, unknown> = {
      chart_id: "trend",
      title: "Trend",
      description: "weekly latency",
      option: { series: [{ type: "line" }] },
      dataset_id: "orders",
    };
    expect(readGenerateEchartsConfigArgs(raw)).toEqual({
      chart_id: "trend",
      title: "Trend",
      description: "weekly latency",
      option: { series: [{ type: "line" }] },
      dataset_id: "orders",
    });
  });

  it("rejects when required fields are missing or wrong-typed", () => {
    // missing chart_id
    expect(
      readGenerateEchartsConfigArgs({ title: "t", option: {} }),
    ).toBeNull();
    // missing title
    expect(
      readGenerateEchartsConfigArgs({ chart_id: "c", option: {} }),
    ).toBeNull();
    // missing option
    expect(
      readGenerateEchartsConfigArgs({ chart_id: "c", title: "t" }),
    ).toBeNull();
    // empty chart_id
    expect(
      readGenerateEchartsConfigArgs({
        chart_id: "",
        title: "t",
        option: {},
      }),
    ).toBeNull();
    // wrong-typed title
    expect(
      readGenerateEchartsConfigArgs({
        chart_id: "c",
        title: 42,
        option: {},
      }),
    ).toBeNull();
    // option is array, not object
    expect(
      readGenerateEchartsConfigArgs({
        chart_id: "c",
        title: "t",
        option: [1, 2, 3],
      }),
    ).toBeNull();
    // option is null
    expect(
      readGenerateEchartsConfigArgs({
        chart_id: "c",
        title: "t",
        option: null,
      }),
    ).toBeNull();
  });

  it("includes optional fields only when present", () => {
    const minimal = readGenerateEchartsConfigArgs({
      chart_id: "c",
      title: "t",
      option: { a: 1 },
    });
    expect(minimal).not.toHaveProperty("description");
    expect(minimal).not.toHaveProperty("dataset_id");
    // ignores non-string optional fields silently
    const withBadOptionals = readGenerateEchartsConfigArgs({
      chart_id: "c",
      title: "t",
      option: { a: 1 },
      description: 42,
      dataset_id: null,
    });
    expect(withBadOptionals).not.toHaveProperty("description");
    expect(withBadOptionals).not.toHaveProperty("dataset_id");
  });
});
