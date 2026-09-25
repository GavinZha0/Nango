import { describe, expect, it } from "vitest";

import {
  chartArgsToContent,
  readGenerateEchartsConfigArgs,
  slideArgsToContent,
  readGenerateBentoSlidesArgs,
} from "@/lib/outcomes/args-to-content";

describe("chartArgsToContent", () => {
  it("wraps the option object in a single ChartBlock", () => {
    const content = chartArgsToContent({
      outcome_id: "trend-2025-01-27",
      title: "Trend",
      option: { series: [{ type: "bar" }] },
    });
    expect(content).toEqual({
      blocks: [{ kind: "chart", option: { series: [{ type: "bar" }] } }],
    });
  });

  it("propagates `dataset_id` onto the block as `datasetName` when present", () => {
    const content = chartArgsToContent({
      outcome_id: "trend",
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
      outcome_id: "trend",
      title: "Trend",
      option: {},
    });
    expect(content?.blocks[0]).not.toHaveProperty("datasetName");
  });

  it("returns null when option is not a plain object", () => {
    expect(
      chartArgsToContent({
        outcome_id: "trend",
        title: "Trend",
        option: [1, 2, 3] as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
    expect(
      chartArgsToContent({
        outcome_id: "trend",
        title: "Trend",
        option: null as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
  });
});

describe("readGenerateEchartsConfigArgs", () => {
  it("returns a typed copy of valid args", () => {
    const raw: Record<string, unknown> = {
      outcome_id: "trend",
      title: "Trend",
      description: "weekly latency",
      option: { series: [{ type: "line" }] },
      dataset_id: "orders",
    };
    expect(readGenerateEchartsConfigArgs(raw)).toEqual({
      outcome_id: "trend",
      title: "Trend",
      description: "weekly latency",
      option: { series: [{ type: "line" }] },
      dataset_id: "orders",
    });
  });

  it("rejects when required fields are missing or wrong-typed", () => {
    // missing outcome_id
    expect(
      readGenerateEchartsConfigArgs({ title: "t", option: {} }),
    ).toBeNull();
    // missing title
    expect(
      readGenerateEchartsConfigArgs({ outcome_id: "c", option: {} }),
    ).toBeNull();
    // missing option
    expect(
      readGenerateEchartsConfigArgs({ outcome_id: "c", title: "t" }),
    ).toBeNull();
    // empty outcome_id
    expect(
      readGenerateEchartsConfigArgs({
        outcome_id: "",
        title: "t",
        option: {},
      }),
    ).toBeNull();
    // wrong-typed title
    expect(
      readGenerateEchartsConfigArgs({
        outcome_id: "c",
        title: 42,
        option: {},
      }),
    ).toBeNull();
    // option is array, not object
    expect(
      readGenerateEchartsConfigArgs({
        outcome_id: "c",
        title: "t",
        option: [1, 2, 3],
      }),
    ).toBeNull();
    // option is null
    expect(
      readGenerateEchartsConfigArgs({
        outcome_id: "c",
        title: "t",
        option: null,
      }),
    ).toBeNull();
  });

  it("includes optional fields only when present", () => {
    const minimal = readGenerateEchartsConfigArgs({
      outcome_id: "c",
      title: "t",
      option: { a: 1 },
    });
    expect(minimal).not.toHaveProperty("description");
    expect(minimal).not.toHaveProperty("dataset_id");
    // ignores non-string optional fields silently
    const withBadOptionals = readGenerateEchartsConfigArgs({
      outcome_id: "c",
      title: "t",
      option: { a: 1 },
      description: 42,
      dataset_id: null,
    });
    expect(withBadOptionals).not.toHaveProperty("description");
    expect(withBadOptionals).not.toHaveProperty("dataset_id");
  });
});

describe("slideArgsToContent", () => {
  it("wraps doc in a single SlideBlock", () => {
    const doc = { format: "bento/slides", slides: [{ id: "s1" }] };
    const content = slideArgsToContent({
      outcome_id: "pitch-deck",
      title: "Pitch",
      doc,
    });
    expect(content).toEqual({
      blocks: [{ kind: "slide", doc, title: "Pitch" }],
    });
  });

  it("returns null when doc is invalid", () => {
    expect(
      slideArgsToContent({
        outcome_id: "bad",
        title: "Bad",
        doc: null as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
    expect(
      slideArgsToContent({
        outcome_id: "bad",
        title: "Bad",
        doc: [1, 2, 3] as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
  });
});

describe("readGenerateBentoSlidesArgs", () => {
  it("returns typed args on valid input", () => {
    const raw = {
      outcome_id: "q3-review",
      title: "Q3 Review",
      description: "Quarterly slides",
      doc: { format: "bento/slides", slides: [] },
    };
    expect(readGenerateBentoSlidesArgs(raw)).toEqual(raw);
  });

  it("rejects invalid input", () => {
    expect(readGenerateBentoSlidesArgs({ title: "No ID", doc: {} })).toBeNull();
    expect(readGenerateBentoSlidesArgs({ outcome_id: "id", doc: {} })).toBeNull();
    expect(readGenerateBentoSlidesArgs({ outcome_id: "id", title: "t" })).toBeNull();
    expect(readGenerateBentoSlidesArgs({ outcome_id: "", title: "t", doc: {} })).toBeNull();
  });
});

