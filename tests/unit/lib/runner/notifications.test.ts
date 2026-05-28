import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ NotificationTable: {} }));
vi.mock("@/lib/observability/logger", () => ({
  childLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/lib/runner/event-bus", () => ({
  publish: vi.fn(),
}));

import { previewBody } from "@/lib/runner/notifications";

describe("previewBody", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(previewBody(null)).toBeNull();
    expect(previewBody(undefined)).toBeNull();
    expect(previewBody("")).toBeNull();
    expect(previewBody("   ")).toBeNull();
  });

  it("returns short text unchanged", () => {
    expect(previewBody("hello world")).toBe("hello world");
  });

  it("truncates text longer than 280 chars with ellipsis", () => {
    const long = "x".repeat(500);
    const result = previewBody(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(281); // 280 + "…"
    expect(result!.endsWith("…")).toBe(true);
  });

  it("strips NUL bytes from the input", () => {
    expect(previewBody("hel\u0000lo")).toBe("hello");
  });

  it("trims whitespace before checking length", () => {
    expect(previewBody("  hi  ")).toBe("hi");
  });
});
