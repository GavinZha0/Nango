import { describe, it, expect } from "vitest";
import { formatResultLength } from "@/components/copilotkit/WildcardToolRenderer";

describe("formatResultLength", () => {
  it("formats zero length string as 0", () => {
    expect(formatResultLength("")).toBe("0");
  });

  it("formats length under 1000 as raw number string", () => {
    expect(formatResultLength("a")).toBe("1");
    expect(formatResultLength("a".repeat(746))).toBe("746");
    expect(formatResultLength("a".repeat(999))).toBe("999");
  });

  it("formats length of 1000 as 1.0k", () => {
    expect(formatResultLength("a".repeat(1000))).toBe("1.0k");
  });

  it("formats length over 1000 in k unit with 1 decimal place", () => {
    expect(formatResultLength("a".repeat(1200))).toBe("1.2k");
    expect(formatResultLength("a".repeat(1249))).toBe("1.2k");
    expect(formatResultLength("a".repeat(1250))).toBe("1.3k");
    expect(formatResultLength("a".repeat(25400))).toBe("25.4k");
  });
});
