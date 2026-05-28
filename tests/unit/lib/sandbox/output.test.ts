import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

import {
  processStderr,
  processStdout,
  truncateEnd,
  truncateMiddle,
} from "@/lib/sandbox/output";

const MAX_STDOUT_CHARS = 20_000;
const MAX_STDERR_CHARS = 10_000;
import { buildMapping } from "@/lib/sandbox/path-mapper";

describe("truncateMiddle", () => {
  it("returns short text unchanged", () => {
    expect(truncateMiddle("hello", 100)).toBe("hello");
  });

  it("keeps both halves with marker when over cap", () => {
    const text = "X".repeat(1000);
    const out = truncateMiddle(text, 100);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("[truncated 900 chars]");
    expect(out.startsWith("XXXXX")).toBe(true);
    expect(out.endsWith("XXXXX")).toBe(true);
  });
});

describe("truncateEnd", () => {
  it("returns short text unchanged", () => {
    expect(truncateEnd("hi", 100)).toBe("hi");
  });

  it("keeps the tail when over cap", () => {
    const head = "A".repeat(500);
    const tail = "B".repeat(100);
    const out = truncateEnd(head + tail, 100);
    expect(out).toContain("[truncated 500 chars]");
    expect(out.endsWith(tail)).toBe(true);
    expect(out.includes("A")).toBe(false);
  });
});

describe("processStdout / processStderr", () => {
  const mapping = buildMapping("/tmp/sandbox-abc", ["sales_q1"]);

  it("masks host paths and respects size cap", () => {
    const huge =
      "/tmp/sandbox-abc/script.py: " + "X".repeat(MAX_STDOUT_CHARS) +
      " from /tmp/sandbox-abc/script.py";
    const out = processStdout(huge, mapping);
    // Per the new sandbox path contract (D38): the subprocess tmp
    // dir IS the cwd, so absolute paths under it get rewritten to
    // cwd-relative form (`./script.py`).
    expect(out).toContain("./script.py");
    expect(out).not.toContain("/tmp/sandbox-abc");
    expect(out).toContain("[truncated");
  });

  it("stderr keeps the tail (most useful for stack traces)", () => {
    const stack =
      "Traceback (most recent call last):\n" +
      "X".repeat(MAX_STDERR_CHARS) +
      "FATAL: at /tmp/sandbox-abc/last.py:42";
    const out = processStderr(stack, mapping);
    expect(out.endsWith("./last.py:42")).toBe(true);
    expect(out.includes("[truncated")).toBe(true);
  });
});
