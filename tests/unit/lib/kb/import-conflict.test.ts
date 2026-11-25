import { describe, expect, it } from "vitest";

import {
  KB_COLLECTION_NAME_RE,
  KB_NAME_MAX_LEN,
  buildSuffixedKbName,
} from "@/lib/kb/validation";

describe("kb/validation — suffixed rename helper", () => {
  it("keeps suffixed names within 63 chars and valid under the slug rule", () => {
    const longName = "a".repeat(KB_NAME_MAX_LEN);
    const renamed = buildSuffixedKbName(longName, "_123");
    expect(renamed.length).toBeLessThanOrEqual(KB_NAME_MAX_LEN);
    expect(renamed.endsWith("_123")).toBe(true);
    expect(KB_COLLECTION_NAME_RE.test(renamed)).toBe(true);
  });

  it("trims the separator a cut left dangling", () => {
    // maxBase for "_123" is 59, so the cut lands right after the dash.
    const base = `${"a".repeat(58)}-tail`;
    const renamed = buildSuffixedKbName(base, "_123");
    expect(renamed).toBe(`${"a".repeat(58)}_123`);
    expect(KB_COLLECTION_NAME_RE.test(renamed)).toBe(true);
  });

  it("keeps a five-digit suffix inside the cap", () => {
    const renamed = buildSuffixedKbName("a".repeat(KB_NAME_MAX_LEN), "_54321");
    expect(renamed.length).toBeLessThanOrEqual(KB_NAME_MAX_LEN);
    expect(renamed.endsWith("_54321")).toBe(true);
    expect(KB_COLLECTION_NAME_RE.test(renamed)).toBe(true);
  });
});
