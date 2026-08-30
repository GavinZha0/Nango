import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { evaluateAssertions } = await import("@/lib/assertions");
type AssertionSpec = import("@/lib/assertions").AssertionSpec;

describe("evaluateAssertions for Web Auto payloads", () => {
  it("extracts expectation assertions and ignores deterministic assertions in llmAssertions", () => {
    const assertions: AssertionSpec[] = [
      { type: "js_expression", expression: "result.success === true" },
      { type: "expectation", expectation: "Title should be visible" },
      { type: "llm_expectation", expectation: "Card has correct price" },
      { type: "jsonpath_equals", path: "$.status", expected: "ok" },
    ];

    const outcome = evaluateAssertions({ result: { status: "ok", success: true } }, assertions);

    expect(outcome.llmAssertions).toHaveLength(2);
    expect(outcome.llmAssertions[0].spec.expectation).toBe("Title should be visible");
    expect(outcome.llmAssertions[1].spec.expectation).toBe("Card has correct price");
  });

  it("passes smoke test when no deterministic assertions are present", () => {
    const output = { result: { ok: true } };
    const outcome = evaluateAssertions(output, [
      { type: "expectation", expectation: "Visual check" },
    ]);

    expect(outcome.allDeterministicPassed).toBe(true);
    expect(outcome.deterministicResults).toHaveLength(0);
  });

  it("evaluates JS expressions with unpacked result, page, and root contexts", () => {
    const output = {
      result: { count: 42, active: true },
      page: { title: "Dashboard", url: "https://example.com" },
    };

    const assertions: AssertionSpec[] = [
      { type: "js_expression", expression: "result.count === 42" },
      { type: "js_expression", expression: "page.title === 'Dashboard'" },
      { type: "js_expression", expression: "root.result.active === true" },
      { type: "js_expression", expression: "result.count < 10" }, // will fail
    ];

    const outcome = evaluateAssertions(output, assertions);

    expect(outcome.allDeterministicPassed).toBe(false);
    expect(outcome.deterministicResults).toHaveLength(4);
    expect(outcome.deterministicResults[0].ok).toBe(true);
    expect(outcome.deterministicResults[1].ok).toBe(true);
    expect(outcome.deterministicResults[2].ok).toBe(true);
    expect(outcome.deterministicResults[3].ok).toBe(false);
  });

  it("evaluates jsonpath_equals and json_schema assertions", () => {
    const output = {
      result: { name: "Alice", age: 30 },
    };

    const assertions: AssertionSpec[] = [
      { type: "jsonpath_equals", path: "$.name", expected: "Alice" },
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
  });
});