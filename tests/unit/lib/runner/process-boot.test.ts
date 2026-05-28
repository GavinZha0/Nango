import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fakeRow = { id: "boot-1", startedAt: new Date("2025-01-01") };
const insertReturning = vi.fn().mockResolvedValue([fakeRow]);
vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnValue({
        returning: insertReturning,
      }),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  ProcessBootTable: { id: "id", startedAt: "started_at" },
}));

const { recordProcessBoot, getCachedProcessBoot } = await import("@/lib/runner/process-boot");

describe("recordProcessBoot", () => {
  it("returns a boot record with startedAt", async () => {
    const result = await recordProcessBoot();
    expect(result.startedAt).toEqual(new Date("2025-01-01"));
  });
});

describe("getCachedProcessBoot", () => {
  it("returns the cached boot record after recordProcessBoot", () => {
    // recordProcessBoot was already called in the test above
    const cached = getCachedProcessBoot();
    expect(cached).toBeDefined();
    expect(cached!.startedAt).toEqual(new Date("2025-01-01"));
  });
});
