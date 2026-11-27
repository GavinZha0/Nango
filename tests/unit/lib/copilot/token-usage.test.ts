import { describe, expect, it } from "vitest";

import {
  formatTokenCount,
  formatTokenPair,
  formatTokenSummary,
  formatTokenTooltip,
  mergeTokenUsage,
  summarizeRunUsage,
  toAgUiUsageEntries,
} from "@/lib/copilot/token-usage";

describe("summarizeRunUsage", () => {
  it("returns null for empty or non-array inputs", () => {
    expect(summarizeRunUsage(undefined)).toBeNull();
    expect(summarizeRunUsage(null)).toBeNull();
    expect(summarizeRunUsage([])).toBeNull();
    expect(summarizeRunUsage("bad")).toBeNull();
    expect(summarizeRunUsage([{}])).toBeNull();
  });

  it("sums multiple provider/model usage entries and derives totalTokens when omitted", () => {
    const result = summarizeRunUsage([
      {
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 800,
        outputTokens: 200,
        cachedInputTokens: 100,
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 440,
        outputTokens: 410,
        totalTokens: 850,
        reasoningTokens: 50,
      },
    ]);

    expect(result).toEqual({
      inputTokens: 1240,
      outputTokens: 610,
      totalTokens: 1850,
      reasoningTokens: 50,
      cachedInputTokens: 100,
    });
  });

  it("supports totalTokens-only entries and ignores negative or non-integer counts", () => {
    expect(
      summarizeRunUsage([
        { inputTokens: -5, outputTokens: 1.5, totalTokens: 1800 },
      ]),
    ).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: 1800,
    });
  });
});

describe("mergeTokenUsage", () => {
  it("merges nullable summaries across runs", () => {
    expect(mergeTokenUsage([null, undefined])).toBeNull();
    expect(
      mergeTokenUsage([
        { inputTokens: 1000, outputTokens: 250, totalTokens: 1250 },
        null,
        { inputTokens: 240, outputTokens: 360, totalTokens: null },
      ]),
    ).toEqual({
      inputTokens: 1240,
      outputTokens: 610,
      totalTokens: 1850,
    });
  });
});

describe("toAgUiUsageEntries", () => {
  it("returns undefined when all counts are null", () => {
    expect(toAgUiUsageEntries(null)).toBeUndefined();
    expect(
      toAgUiUsageEntries({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    ).toBeUndefined();
  });

  it("produces a single AG-UI usage entry with defined fields", () => {
    expect(
      toAgUiUsageEntries({
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
      }),
    ).toEqual([{ inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }]);
  });
});

describe("token display formatters", () => {
  it("formats compact counts", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(610)).toBe("610");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(1240)).toBe("1.2k");
    expect(formatTokenCount(125400)).toBe("125k");
    expect(formatTokenCount(1_460_000)).toBe("1.5M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });

  it("formats directional pairs and omits arrows when only totalTokens exists", () => {
    expect(
      formatTokenPair({
        inputTokens: 1240,
        outputTokens: 610,
        totalTokens: 1850,
      }),
    ).toBe("↑1.2k ↓610");

    expect(
      formatTokenPair({
        inputTokens: null,
        outputTokens: null,
        totalTokens: 1850,
      }),
    ).toBe("1.9k");

    expect(
      formatTokenPair({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    ).toBeNull();
  });

  it("formats summary with total and breakdown", () => {
    expect(
      formatTokenSummary({
        inputTokens: 1240,
        outputTokens: 610,
        totalTokens: 1850,
      }),
    ).toBe("1.9k (↑1.2k ↓610)");

    expect(
      formatTokenSummary({
        inputTokens: null,
        outputTokens: null,
        totalTokens: 1850,
      }),
    ).toBe("1.9k");
  });

  it("formats exact hover tooltip with optional cached/reasoning counts", () => {
    expect(
      formatTokenTooltip({
        inputTokens: 1240,
        outputTokens: 610,
        totalTokens: 1850,
        cachedInputTokens: 300,
        reasoningTokens: 120,
      }),
    ).toBe(
      "Input: 1,240 · Output: 610 · Total: 1,850 · Cached: 300 · Reasoning: 120",
    );

    expect(
      formatTokenTooltip({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    ).toBeUndefined();
  });
});
