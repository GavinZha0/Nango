/**
 * Regression coverage for assertion evaluation.
 *
 * The primary motivator is the `deepEqual` array-vs-object asymmetry
 * bug: `Array.isArray([1,2])` is true but `Array.isArray({"0":1,"1":2})`
 * is false, and `typeof [] === "object"`. Without an explicit
 * symmetry guard, the object-keys branch judges `[1,2]` deep-equal to
 * `{"0":1,"1":2}` (Object.keys of an array returns the index strings).
 * See `@/lib/assertions/evaluator.server.ts` `deepEqual`.
 */

import { describe, it, expect, vi } from "vitest";

// `server-only` is a Next.js boundary marker with no installed
// implementation in the vitest runner — mock it before the SUT loads.
vi.mock("server-only", () => ({}));

const { evaluateAssertions } = await import("@/lib/assertions");
type AssertionSpec = import("@/lib/assertions").AssertionSpec;

/** Build a minimal CallToolResult envelope; the assertion module
 *  scopes JSONPath / js_expression to `structuredContent` by default. */
function envelopeOf(structured: unknown): unknown {
  return { content: [], structuredContent: structured };
}

describe("evaluateAssertions — jsonpath deepEqual", () => {
  it("rejects array vs index-keyed object as NOT equal", () => {
    const payload = envelopeOf({ items: [1, 2] });
    const specs: AssertionSpec[] = [
      { type: "jsonpath", path: "items", expected: { "0": 1, "1": 2 } },
    ];
    const outcome = evaluateAssertions(payload, specs);
    const [result] = outcome.deterministicResults;
    expect(result.ok).toBe(false);
    expect(result.message).toBe("value mismatch");
  });

  it("accepts array vs array of identical contents", () => {
    const payload = envelopeOf({ items: [1, 2] });
    const specs: AssertionSpec[] = [
      { type: "jsonpath", path: "items", expected: [1, 2] },
    ];
    const outcome = evaluateAssertions(payload, specs);
    const [result] = outcome.deterministicResults;
    expect(result.ok).toBe(true);
  });

  it("accepts object vs object of identical contents", () => {
    const payload = envelopeOf({ obj: { a: 1, b: 2 } });
    const specs: AssertionSpec[] = [
      { type: "jsonpath", path: "obj", expected: { a: 1, b: 2 } },
    ];
    const outcome = evaluateAssertions(payload, specs);
    const [result] = outcome.deterministicResults;
    expect(result.ok).toBe(true);
  });

  it("rejects nested arrays vs nested index-keyed objects", () => {
    const payload = envelopeOf({ nested: [[1, 2], [3, 4]] });
    const specs: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "nested",
        expected: [{ "0": 1, "1": 2 }, [3, 4]],
      },
    ];
    const outcome = evaluateAssertions(payload, specs);
    const [result] = outcome.deterministicResults;
    expect(result.ok).toBe(false);
    expect(result.message).toBe("value mismatch");
  });

  it("accepts matching nested arrays", () => {
    const payload = envelopeOf({ nested: [[1, 2], [3, 4]] });
    const specs: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "nested",
        expected: [[1, 2], [3, 4]],
      },
    ];
    const outcome = evaluateAssertions(payload, specs);
    const [result] = outcome.deterministicResults;
    expect(result.ok).toBe(true);
  });

  it("correctly evaluates template substitutions with resolved inputs", () => {
    const payload = envelopeOf({ user: { id: "user-123", name: "Alice" } });
    const specs: AssertionSpec[] = [
      {
        type: "jsonpath",
        path: "user.id",
        expected: "{{input.expectedId}}",
      },
    ];
    const outcome = evaluateAssertions(payload, specs, {
      input: { expectedId: "user-123" },
    });
    const [result] = outcome.deterministicResults;
    expect(result.ok).toBe(true);
  });

  it("evaluates root.isError on error envelope payload for negative test cases", () => {
    const payload = {
      isError: true,
      content: [{ type: "text", text: "Validation error: missing parameter" }],
    };
    const specs: AssertionSpec[] = [
      {
        type: "js_expression",
        expression: "root.isError === true",
      },
      {
        type: "jsonpath",
        path: "$.content[0].type",
        expected: "text",
      },
    ];
    const outcome = evaluateAssertions(payload, specs);
    expect(outcome.allDeterministicPassed).toBe(true);
    expect(outcome.deterministicResults).toHaveLength(2);
    expect(outcome.deterministicResults[0].ok).toBe(true);
    expect(outcome.deterministicResults[1].ok).toBe(true);
  });
});
