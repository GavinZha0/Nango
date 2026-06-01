/**
 * Regression coverage for assertion evaluation.
 *
 * The primary motivator is the `deepEqual` array-vs-object asymmetry
 * bug: `Array.isArray([1,2])` is true but `Array.isArray({"0":1,"1":2})`
 * is false, and `typeof [] === "object"`. Without an explicit
 * symmetry guard, the object-keys branch judges `[1,2]` deep-equal to
 * `{"0":1,"1":2}` (Object.keys of an array returns the index strings).
 * See `@/lib/verification/assertions.ts` `deepEqual`.
 */

import { describe, it, expect, vi } from "vitest";

// `server-only` is a Next.js boundary marker with no installed
// implementation in the vitest runner — mock it before the SUT loads.
vi.mock("server-only", () => ({}));

const { runAssertions } = await import("@/lib/verification/assertions");
type AssertionSpec = import("@/lib/verification/types").AssertionSpec;

/** Build a minimal CallToolResult envelope; the assertion module
 *  scopes JSONPath / js_expression to `structuredContent` by default. */
function envelopeOf(structured: unknown): unknown {
  return { content: [], structuredContent: structured };
}

describe("runAssertions — jsonpath_equals deepEqual", () => {
  it("rejects array vs index-keyed object as NOT equal", () => {
    const payload = envelopeOf({ items: [1, 2] });
    const specs: AssertionSpec[] = [
      { type: "jsonpath_equals", path: "items", expected: { "0": 1, "1": 2 } },
    ];
    const [result] = runAssertions(payload, specs);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("value mismatch");
  });

  it("accepts array vs array of identical contents", () => {
    const payload = envelopeOf({ items: [1, 2] });
    const specs: AssertionSpec[] = [
      { type: "jsonpath_equals", path: "items", expected: [1, 2] },
    ];
    const [result] = runAssertions(payload, specs);
    expect(result.ok).toBe(true);
  });

  it("accepts object vs object of identical contents", () => {
    const payload = envelopeOf({ obj: { a: 1, b: 2 } });
    const specs: AssertionSpec[] = [
      { type: "jsonpath_equals", path: "obj", expected: { a: 1, b: 2 } },
    ];
    const [result] = runAssertions(payload, specs);
    expect(result.ok).toBe(true);
  });

  it("rejects nested arrays vs nested index-keyed objects", () => {
    const payload = envelopeOf({ nested: [[1, 2], [3, 4]] });
    const specs: AssertionSpec[] = [
      {
        type: "jsonpath_equals",
        path: "nested",
        expected: [{ "0": 1, "1": 2 }, { "0": 3, "1": 4 }],
      },
    ];
    const [result] = runAssertions(payload, specs);
    expect(result.ok).toBe(false);
  });
});

describe("runAssertions — js_expression timeout is short", () => {
  it("falls under the per-call wall clock for trivial booleans", () => {
    const payload = envelopeOf({ count: 5 });
    const specs: AssertionSpec[] = [
      { type: "js_expression", expression: "result.count > 0" },
    ];
    const start = Date.now();
    const [result] = runAssertions(payload, specs);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    // Trivial expressions complete in <50 ms; if the V1 timeout regresses
    // back to 1000 ms we'd never notice because successful runs don't
    // wait — this bound exists so a future "timeout shrinks to <X ms"
    // breakage gets caught.
    expect(elapsed).toBeLessThan(250);
  });
});
