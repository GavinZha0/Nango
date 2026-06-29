import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { runDeterministicChecks, formatChecksForPrompt } = await import(
  "@/lib/evaluation/deterministic-checks"
);
type EvalCriteria = import("@/lib/evaluation/types").EvalCriteria;

const BASE_METRICS = { durationMs: 5000, outputTokens: 200, toolCallCount: 2 };

describe("runDeterministicChecks", () => {
  it("passes when all expected keywords are found (case-insensitive)", () => {
    const criteria: EvalCriteria = { expected_keywords: ["delay", "120ms"] };
    const result = runDeterministicChecks(criteria, {
      agentText: "The average Delay is 120ms for this query.",
      actualToolCalls: [],
      metrics: BASE_METRICS,
    });
    expect(result.passRate).toBe(1.0);
    expect(result.results.filter((r) => r.kind === "keyword").every((r) => r.passed)).toBe(true);
  });

  it("fails when an expected keyword is missing", () => {
    const criteria: EvalCriteria = { expected_keywords: ["delay", "timeout"] };
    const result = runDeterministicChecks(criteria, {
      agentText: "The delay is 15ms.",
      actualToolCalls: [],
      metrics: BASE_METRICS,
    });
    expect(result.passedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.passRate).toBe(0.5);
  });

  it("fails when an unexpected keyword is found", () => {
    const criteria: EvalCriteria = { unexpected_keywords: ["error"] };
    const result = runDeterministicChecks(criteria, {
      agentText: "An error occurred during processing.",
      actualToolCalls: [],
      metrics: BASE_METRICS,
    });
    expect(result.passRate).toBe(0);
    expect(result.results[0].passed).toBe(false);
    expect(result.results[0].actual).toBe("found");
  });

  it("passes when tool_calls match", () => {
    const criteria: EvalCriteria = { tool_calls: ["run_sql", "web_search"] };
    const result = runDeterministicChecks(criteria, {
      agentText: "Done.",
      actualToolCalls: ["run_sql", "web_search", "get_current_datetime"],
      metrics: BASE_METRICS,
    });
    expect(result.passRate).toBe(1.0);
  });

  it("fails when expected tool was not called", () => {
    const criteria: EvalCriteria = { tool_calls: ["run_sql"] };
    const result = runDeterministicChecks(criteria, {
      agentText: "Done.",
      actualToolCalls: ["web_search"],
      metrics: BASE_METRICS,
    });
    expect(result.passRate).toBe(0);
    expect(result.results[0].actual).toBe("not called");
  });

  it("passes execution metric thresholds", () => {
    const criteria: EvalCriteria = {
      max_duration_s: 10,
      max_output_tokens: 500,
      max_tool_calls: 5,
    };
    const result = runDeterministicChecks(criteria, {
      agentText: "",
      actualToolCalls: [],
      metrics: { durationMs: 8000, outputTokens: 300, toolCallCount: 3 },
    });
    expect(result.passRate).toBe(1.0);
    expect(result.totalCount).toBe(3);
  });

  it("fails when duration exceeds threshold", () => {
    const criteria: EvalCriteria = { max_duration_s: 10 };
    const result = runDeterministicChecks(criteria, {
      agentText: "",
      actualToolCalls: [],
      metrics: { durationMs: 12000, outputTokens: 0, toolCallCount: 0 },
    });
    expect(result.passRate).toBe(0);
    expect(result.results[0].actual).toBe("12.0s");
  });

  it("leaves LLM-evaluated items as passed=null", () => {
    const criteria: EvalCriteria = {
      expectation: "Should return results",
      assertions: ["delay < 20ms"],
    };
    const result = runDeterministicChecks(criteria, {
      agentText: "Here are results.",
      actualToolCalls: [],
      metrics: BASE_METRICS,
    });
    const llmItems = result.results.filter((r) => r.passed === null);
    expect(llmItems).toHaveLength(2);
    expect(result.totalCount).toBe(0);
    expect(result.passRate).toBe(1.0);
  });

  it("returns passRate=1.0 when no deterministic checks defined", () => {
    const result = runDeterministicChecks({}, {
      agentText: "Hello",
      actualToolCalls: [],
      metrics: BASE_METRICS,
    });
    expect(result.passRate).toBe(1.0);
    expect(result.totalCount).toBe(0);
  });
});

describe("formatChecksForPrompt", () => {
  it("formats only deterministic items (passed !== null)", () => {
    const results = [
      { label: "Expected output", kind: "expectation" as const, passed: null, score: null },
      { label: 'keyword: "delay"', kind: "keyword" as const, passed: true },
      { label: "duration \u2264 10s", kind: "metric" as const, passed: false, actual: "12.3s" },
    ];
    const text = formatChecksForPrompt(results);
    expect(text).toContain("\u2713");
    expect(text).toContain("\u2717");
    expect(text).toContain("12.3s");
    expect(text).not.toContain("Expected output");
  });

  it("returns empty string when no deterministic items", () => {
    const results = [
      { label: "test", kind: "expectation" as const, passed: null },
    ];
    expect(formatChecksForPrompt(results)).toBe("");
  });
});
