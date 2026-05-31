/**
 * Unit coverage for `user-timezone` helpers.
 *
 *  - `isValidTimeZone` is a pure wrapper around `Intl.DateTimeFormat`;
 *    tested against canonical IANA names and obvious garbage to lock
 *    the contract.
 *  - `getUserTimezone` is the DB-resolution path; mocked through
 *    drizzle's chained builder so each test exercises one branch of
 *    the precedence (`absent userId → null`, `valid row → row.tz`,
 *    `null/missing/invalid → null`, `DB throw → null + warn`).
 *
 * `server-only` is the Next.js boundary marker — every server-only
 * module under test mocks it to an empty object (matches the
 * convention used across `tests/unit/lib/`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Drizzle's chained builder — each test reconfigures the chain via
// `mockRow(...)` so behaviour stays explicit per-case.
const mockDb = {
  select: vi.fn(),
};
vi.mock("@/lib/db", () => ({ db: mockDb }));

// Schema mock — only the columns the helper reads.
vi.mock("@/lib/db/schema", () => ({
  UserTable: { id: "id", timezone: "timezone" },
}));

// Capture warn invocations on the DB-throw path.
const warnSpy = vi.fn();
vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const { isValidTimeZone, getUserTimezone } = await import(
  "@/lib/time/user-timezone"
);

/** Configure the drizzle chain to resolve to `[row]` (or `[]` when
 *  `row` is undefined). The helper destructures the first element. */
function mockRow(row: { timezone: string | null } | undefined): void {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  });
}

describe("isValidTimeZone", () => {
  it("accepts canonical IANA names across regions", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown or malformed inputs", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("EST+5")).toBe(false);
    expect(isValidTimeZone("garbage")).toBe(false);
    expect(isValidTimeZone("Asia/Shanghai/extra")).toBe(false);
  });
});

describe("getUserTimezone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits to null when userId is undefined and never hits the DB", async () => {
    const tz = await getUserTimezone(undefined);
    expect(tz).toBe(null);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns the stored IANA name when valid", async () => {
    mockRow({ timezone: "Asia/Shanghai" });
    expect(await getUserTimezone("u1")).toBe("Asia/Shanghai");
  });

  it("returns null when the column is empty (legacy / unset)", async () => {
    mockRow({ timezone: null });
    expect(await getUserTimezone("u1")).toBe(null);
  });

  it("returns null when no user row exists", async () => {
    mockRow(undefined);
    expect(await getUserTimezone("ghost-user")).toBe(null);
  });

  it("rejects a stored non-IANA value (defence-in-depth on dirty data)", async () => {
    mockRow({ timezone: "Not/AZone" });
    expect(await getUserTimezone("u1")).toBe(null);
  });

  it("fails soft to null and logs a warn when the DB throws", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("connection refused");
    });
    expect(await getUserTimezone("u1")).toBe(null);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      event: "lookup_failed",
      userId: "u1",
    });
  });
});
