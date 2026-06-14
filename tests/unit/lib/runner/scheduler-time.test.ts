/**
 * Unit tests for scheduler time arithmetic: `addInterval` and `nextFireAt`.
 *
 * These are the core functions that determine WHEN a schedule fires.
 * Correctness here is critical — a bug means tasks fire at wrong times.
 *
 * Covered:
 *   - addInterval: minute/hour (fixed ms), day/week/month (calendar)
 *   - addInterval: DST spring-forward and fall-back
 *   - nextFireAt: one-shot, recurring, endAt cap, past anchor
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/runner", () => ({ runner: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => "",
  getConfigNumber: () => 0,
  getConfigMs: () => 0,
}));

import { addInterval, nextFireAt } from "@/lib/runner/scheduler";

function utc(iso: string): Date {
  return new Date(iso);
}

// ── addInterval ─────────────────────────────────────────────────────

describe("addInterval — fixed-ms units", () => {
  it("minute adds exactly 60,000 ms", () => {
    const base = utc("2026-06-13T10:00:00Z");
    const result = addInterval(base, 30, "minute", "UTC");
    expect(result.toISOString()).toBe("2026-06-13T10:30:00.000Z");
  });

  it("hour adds exactly 3,600,000 ms", () => {
    const base = utc("2026-06-13T10:00:00Z");
    const result = addInterval(base, 2, "hour", "UTC");
    expect(result.toISOString()).toBe("2026-06-13T12:00:00.000Z");
  });

  it("minute/hour ignore timezone (fixed ms)", () => {
    const base = utc("2026-06-13T10:00:00Z");
    const utcResult = addInterval(base, 1, "hour", "UTC");
    const nyResult = addInterval(base, 1, "hour", "America/New_York");
    expect(utcResult.getTime()).toBe(nyResult.getTime());
  });
});

describe("addInterval — calendar units", () => {
  it("day: +1 day preserves wall-clock time", () => {
    // 2026-06-13 10:00 AM EDT → 2026-06-14 10:00 AM EDT
    const base = utc("2026-06-13T14:00:00Z"); // 10:00 AM EDT
    const result = addInterval(base, 1, "day", "America/New_York");
    expect(result.toISOString()).toBe("2026-06-14T14:00:00.000Z");
  });

  it("week: +1 week = +7 days", () => {
    const base = utc("2026-06-13T14:00:00Z");
    const result = addInterval(base, 1, "week", "America/New_York");
    expect(result.toISOString()).toBe("2026-06-20T14:00:00.000Z");
  });

  it("month: +1 month preserves day-of-month", () => {
    // June 15 → July 15
    const base = utc("2026-06-15T14:00:00Z");
    const result = addInterval(base, 1, "month", "America/New_York");
    expect(result.toISOString()).toBe("2026-07-15T14:00:00.000Z");
  });

  it("month: handles month-end overflow by clamping to target month's end (Jan 31 + 1 month)", () => {
    // Jan 31 → Feb 28 (2026 is not a leap year)
    const base = utc("2026-01-31T15:00:00Z"); // 10:00 AM EST
    const result = addInterval(base, 1, "month", "America/New_York");
    // Expected: Feb 28, rather than overflowing into March.
    expect(result.toISOString()).toBe("2026-02-28T15:00:00.000Z");
  });
});

describe("addInterval — DST transitions", () => {
  it("spring forward: day interval preserves wall-clock (23h real)", () => {
    // 2026-03-07 10:00 AM EST = 15:00 UTC (day before DST)
    // DST springs forward on 2026-03-08 at 2:00 AM → 3:00 AM
    // +1 day should give 2026-03-08 10:00 AM EDT = 14:00 UTC (23h later)
    const base = utc("2026-03-07T15:00:00Z");
    const result = addInterval(base, 1, "day", "America/New_York");
    expect(result.toISOString()).toBe("2026-03-08T14:00:00.000Z");
  });

  it("fall back: day interval preserves wall-clock (25h real)", () => {
    // 2026-10-31 10:00 AM EDT = 14:00 UTC (day before DST fall-back)
    // DST falls back on 2026-11-01 at 2:00 AM → 1:00 AM
    // +1 day should give 2026-11-01 10:00 AM EST = 15:00 UTC (25h later)
    const base = utc("2026-10-31T14:00:00Z");
    const result = addInterval(base, 1, "day", "America/New_York");
    expect(result.toISOString()).toBe("2026-11-01T15:00:00.000Z");
  });
});

// ── nextFireAt ──────────────────────────────────────────────────────

function makeScheduleRow(overrides: Record<string, unknown>) {
  return {
    id: "sched-1",
    ownerId: "user-1",
    createdBy: "user-1",
    entityId: "agent-1",
    entityKind: "agent",
    entitySource: "builtin",
    credentialId: null,
    sourceLabel: "Test",
    name: null,
    task: "do something",
    startAt: utc("2026-06-13T14:00:00Z"),
    endAt: null as Date | null,
    intervalValue: null as number | null,
    intervalUnit: null as string | null,
    timezone: "America/New_York",
    enabled: true,
    lastTriggeredAt: null as Date | null,
    lastError: null as string | null,
    createdAt: utc("2026-06-13T00:00:00Z"),
    updatedAt: utc("2026-06-13T00:00:00Z"),
    ...overrides,
  };
}

describe("nextFireAt — one-shot", () => {
  it("returns startAt when not yet fired", () => {
    const row = makeScheduleRow({});
    const result = nextFireAt(row, utc("2026-06-13T10:00:00Z"));
    expect(result?.toISOString()).toBe("2026-06-13T14:00:00.000Z");
  });

  it("returns null after fired (lastTriggeredAt set)", () => {
    const row = makeScheduleRow({
      lastTriggeredAt: utc("2026-06-13T14:00:01Z"),
    });
    const result = nextFireAt(row, utc("2026-06-13T15:00:00Z"));
    expect(result).toBeNull();
  });
});

describe("nextFireAt — recurring", () => {
  it("returns next fire after now", () => {
    const row = makeScheduleRow({
      intervalValue: 1,
      intervalUnit: "day",
      lastTriggeredAt: utc("2026-06-13T14:00:00Z"),
    });
    // now is just after the last trigger
    const result = nextFireAt(row, utc("2026-06-13T14:00:01Z"));
    expect(result?.toISOString()).toBe("2026-06-14T14:00:00.000Z");
  });

  it("skips past fires when now is far ahead", () => {
    const row = makeScheduleRow({
      startAt: utc("2026-06-01T14:00:00Z"),
      intervalValue: 1,
      intervalUnit: "day",
    });
    // now is June 10 — should skip to June 10 or later
    const result = nextFireAt(row, utc("2026-06-10T15:00:00Z"));
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBeGreaterThanOrEqual(
      utc("2026-06-10T15:00:00Z").getTime(),
    );
  });

  it("returns null when past endAt", () => {
    const row = makeScheduleRow({
      intervalValue: 1,
      intervalUnit: "day",
      endAt: utc("2026-06-14T14:00:00Z"),
    });
    const result = nextFireAt(row, utc("2026-06-15T00:00:00Z"));
    expect(result).toBeNull();
  });

  it("returns the fire just before endAt", () => {
    const row = makeScheduleRow({
      startAt: utc("2026-06-13T14:00:00Z"),
      intervalValue: 1,
      intervalUnit: "day",
      endAt: utc("2026-06-15T20:00:00Z"), // after 6/15 14:00 but before 6/16 14:00
    });
    const result = nextFireAt(row, utc("2026-06-14T15:00:00Z"));
    expect(result?.toISOString()).toBe("2026-06-15T14:00:00.000Z");
  });
});

describe("nextFireAt — hourly interval", () => {
  it("advances by fixed hours", () => {
    const row = makeScheduleRow({
      startAt: utc("2026-06-13T10:00:00Z"),
      intervalValue: 2,
      intervalUnit: "hour",
      lastTriggeredAt: utc("2026-06-13T12:00:00Z"),
    });
    const result = nextFireAt(row, utc("2026-06-13T12:00:01Z"));
    expect(result?.toISOString()).toBe("2026-06-13T14:00:00.000Z");
  });
});
