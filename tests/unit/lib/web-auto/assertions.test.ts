import { describe, expect, it } from "vitest";

const { evaluateAssertions } = await import("@/lib/assertions");
type AssertionSpec = import("@/lib/assertions").AssertionSpec;

describe("evaluateAssertions for Web Auto payloads", () => {
  it("extracts expectation assertions and ignores deterministic assertions in llmAssertions", () => {
    const assertions: AssertionSpec[] = [
      { type: "js_expression", expression: "result.success === true" },
      { type: "llm_custom", expectation: "Title should be visible" },
      { type: "llm_custom", expectation: "Card has correct price" },
      { type: "jsonpath", path: "$.status", expected: "ok" },
    ];

    const outcome = evaluateAssertions({ result: { status: "ok", success: true } }, assertions);

    expect(outcome.llmAssertions).toHaveLength(2);
    expect((outcome.llmAssertions[0].spec as import("@/lib/assertions").LlmCustomAssertion).expectation).toBe("Title should be visible");
    expect((outcome.llmAssertions[1].spec as import("@/lib/assertions").LlmCustomAssertion).expectation).toBe("Card has correct price");
  });

  it("passes smoke test when no deterministic assertions are present", () => {
    const output = { result: { ok: true } };
    const outcome = evaluateAssertions(output, [
      { type: "llm_custom", expectation: "Visual check" },
    ]);

    expect(outcome.allDeterministicPassed).toBe(true);
    expect(outcome.deterministicResults).toHaveLength(0);
  });

  it("evaluates JS expressions with result/root contexts and never injects page", () => {
    const output = {
      result: { count: 42, active: true },
      _page: { title: "Dashboard", url: "https://example.com" },
    };

    const assertions: AssertionSpec[] = [
      { type: "js_expression", expression: "result.count === 42" },
      { type: "js_expression", expression: "typeof page === 'undefined'" },
      { type: "js_expression", expression: "root._page.url === 'https://example.com'" },
      { type: "js_expression", expression: "result.count < 10" }, // will fail
    ];

    const outcome = evaluateAssertions(output, assertions);

    expect(outcome.allDeterministicPassed).toBe(false);
    expect(outcome.deterministicResults).toHaveLength(4);
    expect(outcome.deterministicResults[0].ok).toBe(true);
    expect(outcome.deterministicResults[1].ok).toBe(true); // page binding stripped
    expect(outcome.deterministicResults[2].ok).toBe(true); // page metadata reachable via root._page
    expect(outcome.deterministicResults[3].ok).toBe(false);
  });

  it("evaluates jsonpath and json_schema assertions", () => {
    const output = {
      result: { name: "Alice", age: 30 },
      _page: { url: "https://example.com/test", title: "Test" },
    };

    const assertions: AssertionSpec[] = [
      { type: "jsonpath", path: "name", expected: "Alice" },
      { type: "jsonpath", path: "result.name", expected: "Alice" },
      { type: "jsonpath", path: "$._page.url", expected: "https://example.com/test" },
      {
        type: "json_schema",
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

    const outcome = evaluateAssertions(output, assertions);

    expect(outcome.allDeterministicPassed).toBe(true);
    expect(outcome.deterministicResults[0].ok).toBe(true);
    expect(outcome.deterministicResults[1].ok).toBe(true);
    expect(outcome.deterministicResults[2].ok).toBe(true);
    expect(outcome.deterministicResults[3].ok).toBe(true);
  });

  it("correctly handles business payloads containing result field inside Web-Auto envelope", () => {
    const output = {
      result: { result: "SUBMITTED", code: 201 },
      _page: { url: "https://example.com/order", title: "Order" },
    };

    const assertions: AssertionSpec[] = [
      // Whole business result
      { type: "jsonpath", path: "result", expected: { result: "SUBMITTED", code: 201 } },
      // Nested result field: result.result
      { type: "jsonpath", path: "result.result", expected: "SUBMITTED" },
      { type: "jsonpath", path: "result.code", expected: 201 },
      { type: "jsonpath", path: "code", expected: 201 },
      // Raw envelope _page
      { type: "jsonpath", path: "$._page.url", expected: "https://example.com/order" },
      { type: "jsonpath", path: "root._page.title", expected: "Order" },
      // JS expression
      {
        type: "js_expression",
        expression:
          "result.result === 'SUBMITTED' && result.code === 201 && code === 201 && root._page.title === 'Order'",
      },
    ];

    const outcome = evaluateAssertions(output, assertions);
    expect(outcome.allDeterministicPassed).toBe(true);
    expect(outcome.deterministicResults).toHaveLength(7);
    expect(outcome.deterministicResults.every((r) => r.ok)).toBe(true);
  });
});