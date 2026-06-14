/**
 * Unit tests for the unified `formatTimestamp` formatter.
 *
 * The function is fixed to `en-US` locale, no year, with four styles:
 *   datetime         → "6/13, 10:51 AM"
 *   time             → "10:51 AM"
 *   datetimePrecise  → "6/13, 10:51:03 AM"
 *   timePrecise      → "10:51:03 AM"
 *
 * Tests cover:
 *   - Each style produces the expected shape
 *   - The `timeZone` parameter shifts the output correctly
 *   - Null / undefined / invalid inputs return "—"
 *   - Date objects are accepted alongside ISO strings
 */

import { describe, it, expect } from "vitest";

import { formatTimestamp } from "@/components/admin/format";

// Fixed instant: 2026-06-13T14:51:03.000Z (UTC)
// In America/New_York (EDT, UTC-4): 10:51:03 AM on 6/13
// In Asia/Shanghai (UTC+8):         10:51:03 PM on 6/13
const ISO = "2026-06-13T14:51:03.000Z";

describe("formatTimestamp — style variants", () => {
  it("datetime (default): date + time, no seconds", () => {
    const result = formatTimestamp(ISO, "America/New_York");
    expect(result).toBe("6/13, 10:51 AM");
  });

  it("time: time only, no date, no seconds", () => {
    const result = formatTimestamp(ISO, "America/New_York", "time");
    expect(result).toBe("10:51 AM");
  });

  it("datetimePrecise: date + time + seconds", () => {
    const result = formatTimestamp(ISO, "America/New_York", "datetimePrecise");
    expect(result).toBe("6/13, 10:51:03 AM");
  });

  it("timePrecise: time + seconds, no date", () => {
    const result = formatTimestamp(ISO, "America/New_York", "timePrecise");
    expect(result).toBe("10:51:03 AM");
  });
});

describe("formatTimestamp — timezone shifts", () => {
  it("same instant renders differently in different timezones", () => {
    const ny = formatTimestamp(ISO, "America/New_York");
    const sh = formatTimestamp(ISO, "Asia/Shanghai");
    // NY: 10:51 AM, Shanghai: 10:51 PM
    expect(ny).toContain("10:51 AM");
    expect(sh).toContain("10:51 PM");
  });

  it("UTC renders the raw UTC time", () => {
    const result = formatTimestamp(ISO, "UTC");
    expect(result).toBe("6/13, 2:51 PM");
  });

  it("timezone can shift the date (crossing midnight)", () => {
    // 2026-06-13T03:00:00Z → in America/New_York (EDT): 6/12, 11:00 PM
    const lateUtc = "2026-06-13T03:00:00.000Z";
    const result = formatTimestamp(lateUtc, "America/New_York");
    expect(result).toBe("6/12, 11:00 PM");
  });
});

describe("formatTimestamp — null / invalid / edge cases", () => {
  it("returns '—' for null", () => {
    expect(formatTimestamp(null, "UTC")).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatTimestamp(undefined, "UTC")).toBe("—");
  });

  it("returns '—' for empty string", () => {
    expect(formatTimestamp("", "UTC")).toBe("—");
  });

  it("returns '—' for invalid date string", () => {
    expect(formatTimestamp("not-a-date", "UTC")).toBe("—");
  });

  it("accepts a Date object", () => {
    const d = new Date("2026-06-13T14:51:03.000Z");
    const result = formatTimestamp(d, "America/New_York");
    expect(result).toBe("6/13, 10:51 AM");
  });

  it("works without timeZone parameter (falls back to system tz)", () => {
    const result = formatTimestamp(ISO);
    expect(typeof result).toBe("string");
    expect(result).not.toBe("—");
  });
});
