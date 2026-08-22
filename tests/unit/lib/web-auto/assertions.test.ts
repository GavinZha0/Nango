import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  extractExpectationAssertions,
  runDeterministicAssertions,
} = await import("@/lib/web-auto/assertions");

describe("extractExpectationAssertions", () => {
  it("extracts expectation assertions and ignores deterministic assertions", () => {
    const assertions = [
      { type: "js_expression" as const, expression: "result.success === true" },
      { type: "expectation" as const, expectation: "Title should be visible", context: ["admin"] },
      { type: "llm_expectation" as const, description: "Card has correct price", referenceImage: "base64..." },
      { type: "jsonpath_equals" as const, path: "$.status", expected: "ok" },
      { type: "expectation" as const, expectation: "   " }, // blank, should be filtered out
    ];

    const result = extractExpectationAssertions(assertions);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      expectation: "Title should be visible",
      referenceImage: undefined,
      context: ["admin"],
    });
    expect(result[1]).toEqual({
      expectation: "Card has correct price",
      referenceImage: "base64...",
      context: undefined,
    });
  });
});

describe("runDeterministicAssertions", () => {
  it("passes smoke test when no deterministic assertions are present", () => {
    const output = { result: { ok: true } };
    const res = runDeterministicAssertions(output, [
      { type: "expectation", expectation: "Visual check" },
    ]);

    expect(res.passed).toBe(true);
    expect(res.results).toHaveLength(0);
  });

  it("evaluates JS expressions with unpacked result, page, and root contexts", () => {
    const output = {
      result: { count: 42, active: true },
      page: { title: "Dashboard", url: "https://example.com" },
    };

    const assertions = [
      { type: "js_expression" as const, expression: "result.count === 42" },
      { type: "js_expression" as const, expression: "page.title === 'Dashboard'" },
      { type: "js_expression" as const, expression: "root.result.active === true" },
      { type: "js_expression" as const, expression: "result.count < 10" }, // will fail
    ];

    const res = runDeterministicAssertions(output, assertions);

    expect(res.passed).toBe(false);
    expect(res.results).toHaveLength(4);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[1].ok).toBe(true);
    expect(res.results[2].ok).toBe(true);
    expect(res.results[3].ok).toBe(false);
  });

  it("evaluates jsonpath_equals and json_schema assertions", () => {
    const output = {
      result: { name: "Alice", age: 30 },
    };

    const assertions = [
      { type: "jsonpath_equals" as const, path: "$.name", expected: "Alice" },
      {
        type: "json_schema" as const,
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["name", "age"],
        },
      },
    ];

    const res = runDeterministicAssertions(output, assertions);

    expect(res.passed).toBe(true);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[1].ok).toBe(true);
  });
});