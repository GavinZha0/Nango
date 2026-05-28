import { describe, expect, it } from "vitest";

import {
  STATUS_PRIORITY,
  durationMsBetween,
  pickWorstStatus,
} from "@/lib/runner/thread-metrics";

describe("pickWorstStatus", () => {
  it("returns 'succeeded' for an empty array (defensive default)", () => {
    expect(pickWorstStatus([])).toBe("succeeded");
  });

  it("returns the only status when the array contains one entry", () => {
    expect(pickWorstStatus(["succeeded"])).toBe("succeeded");
    expect(pickWorstStatus(["failed"])).toBe("failed");
    expect(pickWorstStatus(["running"])).toBe("running");
  });

  it("picks 'failed' over any other status (highest priority)", () => {
    expect(pickWorstStatus(["succeeded", "failed"])).toBe("failed");
    expect(pickWorstStatus(["running", "failed"])).toBe("failed");
    expect(pickWorstStatus(["cancelled", "failed", "succeeded"])).toBe(
      "failed",
    );
  });

  it("picks 'running' over 'succeeded' / 'cancelled' (in-flight wins)", () => {
    expect(pickWorstStatus(["succeeded", "running"])).toBe("running");
    expect(pickWorstStatus(["cancelled", "running"])).toBe("running");
  });

  it("picks 'awaiting_input' over 'paused' / 'cancelled' / 'succeeded'", () => {
    expect(pickWorstStatus(["awaiting_input", "succeeded"])).toBe(
      "awaiting_input",
    );
    expect(pickWorstStatus(["paused", "awaiting_input"])).toBe(
      "awaiting_input",
    );
  });

  it("returns the first array element for an unranked status set (defensive)", () => {
    // Mimics the table growing a new status value the priority list
    // doesn't yet know about: we surface SOMETHING rather than ""
    expect(pickWorstStatus(["mystery_state"])).toBe("mystery_state");
  });

  it("priority order is consistent with the exported list", () => {
    // Round-trip every priority entry through pickWorstStatus paired
    // with the LAST (best) status — the winning pick must match the
    // declared order.
    for (let i = 0; i < STATUS_PRIORITY.length - 1; i++) {
      const stronger = STATUS_PRIORITY[i]!;
      const weaker = STATUS_PRIORITY[STATUS_PRIORITY.length - 1]!;
      expect(pickWorstStatus([weaker, stronger])).toBe(stronger);
    }
  });
});

describe("durationMsBetween", () => {
  it("returns the positive delta in ms", () => {
    const start = "2026-05-15T10:00:00.000Z";
    const end = "2026-05-15T10:00:05.000Z";
    expect(durationMsBetween(start, end)).toBe(5000);
  });

  it("accepts Date objects on either side", () => {
    const start = new Date("2026-05-15T10:00:00.000Z");
    const end = new Date("2026-05-15T10:00:00.250Z");
    expect(durationMsBetween(start, end)).toBe(250);
  });

  it("accepts a mix of Date and ISO string", () => {
    const start = new Date("2026-05-15T10:00:00.000Z");
    const end = "2026-05-15T10:00:01.500Z";
    expect(durationMsBetween(start, end)).toBe(1500);
  });

  it("returns null when start is null/undefined", () => {
    expect(durationMsBetween(null, "2026-05-15T10:00:05.000Z")).toBeNull();
    expect(durationMsBetween(undefined, "2026-05-15T10:00:05.000Z")).toBeNull();
  });

  it("returns null when end is null/undefined (still-running case)", () => {
    expect(durationMsBetween("2026-05-15T10:00:00.000Z", null)).toBeNull();
    expect(durationMsBetween("2026-05-15T10:00:00.000Z", undefined)).toBeNull();
  });

  it("returns null when both are null/undefined", () => {
    expect(durationMsBetween(null, null)).toBeNull();
    expect(durationMsBetween(undefined, undefined)).toBeNull();
  });

  it("returns null when end < start (clock skew or invalid range)", () => {
    const start = "2026-05-15T10:00:05.000Z";
    const end = "2026-05-15T10:00:00.000Z";
    expect(durationMsBetween(start, end)).toBeNull();
  });

  it("returns null when either side is an unparseable string", () => {
    expect(durationMsBetween("not-a-date", "2026-05-15T10:00:00Z")).toBeNull();
    expect(durationMsBetween("2026-05-15T10:00:00Z", "garbage")).toBeNull();
  });

  it("returns 0 for identical timestamps (run finished at the exact ts it started)", () => {
    const t = "2026-05-15T10:00:00.000Z";
    expect(durationMsBetween(t, t)).toBe(0);
  });
});
