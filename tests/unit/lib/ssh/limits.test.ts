import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

const { getSshLimits } = await import("@/lib/ssh/limits");

describe("getSshLimits", () => {
  it("returns sensible defaults from config service", () => {
    const limits = getSshLimits();
    expect(limits.execTimeoutMs).toBe(30_000);
    expect(limits.connectTimeoutMs).toBe(10_000);
    expect(limits.maxOutputBytes).toBe(1_048_576);
  });

  it("returns consistent values across calls", () => {
    const a = getSshLimits();
    const b = getSshLimits();
    expect(b.execTimeoutMs).toBe(a.execTimeoutMs);
    expect(b.connectTimeoutMs).toBe(a.connectTimeoutMs);
    expect(b.maxOutputBytes).toBe(a.maxOutputBytes);
  });
});
