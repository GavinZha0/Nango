import { describe, it, expect } from "vitest";
import { isDeepEqual, formatCharCount, formatBytes } from "@/lib/utils";

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
    const objA = { type: "llm_custom", expectation: "valid", score: 100 };
    const objB = { score: 100, type: "llm_custom", expectation: "valid" };
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

describe("formatCharCount", () => {
  it("formats counts under 1000 with 'c' suffix", () => {
    expect(formatCharCount(0)).toBe("0c");
    expect(formatCharCount(640)).toBe("640c");
    expect(formatCharCount(999)).toBe("999c");
  });

  it("formats counts 1000 and above with 'k' suffix rounded to 1 decimal place", () => {
    expect(formatCharCount(1000)).toBe("1.0k");
    expect(formatCharCount(1266)).toBe("1.3k");
    expect(formatCharCount(10450)).toBe("10.5k");
    expect(formatCharCount(1500)).toBe("1.5k");
  });
});

describe("formatBytes", () => {
  it("formats counts under 1 KiB in whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(842)).toBe("842 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats KiB with 1 decimal place", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12697)).toBe("12.4 KB");
    expect(formatBytes(262144)).toBe("256.0 KB");
  });

  it("formats MiB with 1 decimal place and stops there", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(10485760)).toBe("10.0 MB");
    // The per-skill cap is 10 MB, so anything above is out of range for the UI.
    expect(formatBytes(1073741824)).toBe("1024.0 MB");
  });
});
