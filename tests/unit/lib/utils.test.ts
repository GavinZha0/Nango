import { describe, it, expect } from "vitest";
import { isDeepEqual } from "@/lib/utils";

describe("isDeepEqual", () => {
  it("compares primitive values", () => {
    expect(isDeepEqual(1, 1)).toBe(true);
    expect(isDeepEqual("a", "a")).toBe(true);
    expect(isDeepEqual(true, true)).toBe(true);
    expect(isDeepEqual(null, null)).toBe(true);
    expect(isDeepEqual(1, 2)).toBe(false);
    expect(isDeepEqual("a", "b")).toBe(false);
    expect(isDeepEqual(null, undefined)).toBe(false);
  });

  it("handles object key re-ordering without false-dirty", () => {
    const objA = { type: "llm_judge", expectation: "valid", score: 100 };
    const objB = { score: 100, type: "llm_judge", expectation: "valid" };
    expect(isDeepEqual(objA, objB)).toBe(true);
  });

  it("filters undefined values cleanly", () => {
    const objA = { a: 1, b: undefined };
    const objB = { a: 1 };
    expect(isDeepEqual(objA, objB)).toBe(true);
  });

  it("compares nested arrays of objects regardless of key order in objects", () => {
    const arrA = [
      { id: 1, name: "Alpha", meta: { rank: 1, tag: "A" } },
      { id: 2, name: "Beta" },
    ];
    const arrB = [
      { name: "Alpha", id: 1, meta: { tag: "A", rank: 1 } },
      { id: 2, name: "Beta" },
    ];
    expect(isDeepEqual(arrA, arrB)).toBe(true);

    const arrC = [
      { id: 2, name: "Beta" },
      { id: 1, name: "Alpha" },
    ];
    // Array element order matters
    expect(isDeepEqual(arrA, arrC)).toBe(false);
  });
});
