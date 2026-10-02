import { describe, it, expect } from "vitest";
import { computeNextCasePrefix } from "@/lib/testing/case-prefix";

describe("computeNextCasePrefix (shared testing utility)", () => {
  it("defaults to 010_ when there are no existing cases", () => {
    expect(computeNextCasePrefix([])).toBe("010_");
  });

  it("defaults to 010_ when cases have no numeric prefix", () => {
    expect(computeNextCasePrefix([{ name: "login" }, { name: "get_user" }])).toBe("010_");
  });

  it("increments by 10 from the highest number and rounds up to next 10s boundary", () => {
    expect(computeNextCasePrefix([{ name: "010_login" }])).toBe("020_");
    expect(computeNextCasePrefix([{ name: "010_login" }, { name: "020_profile" }])).toBe("030_");
    expect(computeNextCasePrefix([{ name: "010_login" }, { name: "015_check" }])).toBe("020_");
    expect(computeNextCasePrefix([{ name: "025_check" }])).toBe("030_");
  });

  it("handles leading and trailing whitespace around case names", () => {
    expect(computeNextCasePrefix([{ name: "   040_test   " }])).toBe("050_");
  });

  it("supports large numbers with padStart 3 digits", () => {
    expect(computeNextCasePrefix([{ name: "090_cleanup" }])).toBe("100_");
    expect(computeNextCasePrefix([{ name: "100_followup" }])).toBe("110_");
  });
});
