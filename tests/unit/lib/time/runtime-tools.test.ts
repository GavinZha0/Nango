/**
 * Unit coverage for the ambient `get_current_datetime` tool.
 *
 * Three things to lock down:
 *
 *   1. Timezone precedence — explicit override (valid IANA) wins;
 *      invalid override falls through to profile; absent profile
 *      falls through to the server timezone. The first stage
 *      short-circuits the DB lookup.
 *   2. `utcOffsetMinutes` correctness across regions and DST
 *      boundaries — this is hand-rolled math (formatToParts diff
 *      against UTC) and the kind of algorithm that quietly breaks
 *      on calendar edges. `vi.setSystemTime` pins `now` to a fixed
 *      UTC instant in May (DST active) and another in January (DST
 *      off in the northern hemisphere) so we exercise both phases.
 *   3. `iso` returns the UTC absolute instant regardless of the
 *      reporting zone — downstream consumers (LLM, schedule code)
 *      must be able to compute future ISO strings from this anchor.
 *
 * `defineTool` is mocked to identity so the wrapped tool object
 * exposes `execute` directly; `getUserTimezone` is mocked so each
 * test controls the profile-resolution result independently of the
 * DB; `isValidTimeZone` is re-implemented locally (5 lines) to keep
 * the override-validation path realistic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// defineTool is just a typed identity helper — keeping the wrapping
// transparent lets the test reach `tool.execute` directly.
vi.mock("@/lib/copilot/index.server", () => ({
  defineTool: <T>(def: T): T => def,
}));

// Mock the user-timezone module wholesale so the test never touches
// the DB. `isValidTimeZone` is duplicated here (it's a 5-line pure
// function in production) so the override-validation path stays
// exercised faithfully.
const getUserTimezoneMock = vi.fn<(userId: string | undefined) => Promise<string | null>>();
vi.mock("@/lib/time/user-timezone", () => ({
  getUserTimezone: getUserTimezoneMock,
  isValidTimeZone: (tz: string): boolean => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
}));

const { buildGetCurrentDatetimeTool } = await import(
  "@/lib/time/runtime-tools"
);

interface ExecuteResult {
  iso: string;
  timezone: string;
  utcOffsetMinutes: number;
  localized: string;
  weekday: string;
}

async function runExec(
  opts: { userId?: string },
  args: { timezone?: string } = {},
): Promise<ExecuteResult> {
  const tool = buildGetCurrentDatetimeTool(opts);
  const exec = tool.execute as (a: { timezone?: string }) => Promise<ExecuteResult>;
  return exec(args);
}

describe("buildGetCurrentDatetimeTool — tool shape", () => {
  it("registers the canonical name and exposes execute / parameters", () => {
    const tool = buildGetCurrentDatetimeTool({});
    expect(tool.name).toBe("get_current_datetime");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });
});

describe("buildGetCurrentDatetimeTool — timezone precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00Z"));
    getUserTimezoneMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a valid override and never hits the profile lookup", async () => {
    getUserTimezoneMock.mockResolvedValue("Asia/Shanghai");
    const r = await runExec({ userId: "u" }, { timezone: "America/New_York" });
    expect(r.timezone).toBe("America/New_York");
    expect(getUserTimezoneMock).not.toHaveBeenCalled();
  });

  it("falls through an invalid override to the profile timezone", async () => {
    getUserTimezoneMock.mockResolvedValue("Asia/Shanghai");
    const r = await runExec({ userId: "u" }, { timezone: "Not/AZone" });
    expect(r.timezone).toBe("Asia/Shanghai");
    expect(getUserTimezoneMock).toHaveBeenCalledWith("u");
  });

  it("ignores a whitespace-only override (treated as no override)", async () => {
    getUserTimezoneMock.mockResolvedValue("Asia/Shanghai");
    const r = await runExec({ userId: "u" }, { timezone: "   " });
    expect(r.timezone).toBe("Asia/Shanghai");
  });

  it("uses the profile timezone when no override is given", async () => {
    getUserTimezoneMock.mockResolvedValue("Europe/London");
    const r = await runExec({ userId: "u" });
    expect(r.timezone).toBe("Europe/London");
    expect(getUserTimezoneMock).toHaveBeenCalledWith("u");
  });

  it("falls back to the server timezone when the profile is unset", async () => {
    getUserTimezoneMock.mockResolvedValue(null);
    const r = await runExec({ userId: "u" });
    const serverTz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    expect(r.timezone).toBe(serverTz);
  });

  it("falls back to the server timezone when userId itself is absent", async () => {
    getUserTimezoneMock.mockResolvedValue(null);
    const r = await runExec({});
    expect(typeof r.timezone).toBe("string");
    expect(getUserTimezoneMock).toHaveBeenCalledWith(undefined);
  });
});

describe("buildGetCurrentDatetimeTool — utcOffsetMinutes / iso", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserTimezoneMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("on a fixed instant in May (NH summer — DST active)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-30T12:00:00Z"));
    });

    it.each([
      ["Asia/Shanghai", 480],
      ["Asia/Kolkata", 330],
      ["UTC", 0],
      ["America/New_York", -240], // EDT
      ["Europe/London", 60], //      BST
    ])("%s offset from UTC = %i minutes", async (tz, expected) => {
      const r = await runExec({}, { timezone: tz });
      expect(r.utcOffsetMinutes).toBe(expected);
    });
  });

  describe("on a fixed instant in January (NH winter — DST off)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    });

    it.each([
      ["America/New_York", -300], // EST
      ["Europe/London", 0], //      GMT
    ])("DST boundary: %s offset = %i minutes", async (tz, expected) => {
      const r = await runExec({}, { timezone: tz });
      expect(r.utcOffsetMinutes).toBe(expected);
    });
  });

  it("`iso` is the UTC absolute instant, independent of the reporting zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const r = await runExec({}, { timezone: "Asia/Shanghai" });
    expect(r.iso).toBe("2026-05-30T12:00:00.000Z");
  });

  it("returns a non-empty localized string and weekday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00Z")); // Saturday UTC
    const r = await runExec({}, { timezone: "Asia/Shanghai" });
    // Shanghai 2026-05-30 12:00 UTC → 20:00 local, still Saturday.
    expect(r.weekday).toBe("Saturday");
    expect(r.localized.length).toBeGreaterThan(0);
  });
});
