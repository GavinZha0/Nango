import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  EntityRunTable: {},
  EntityRunEventTable: {},
}));
vi.mock("@/lib/backends/types", () => ({}));

import { RecursionDepthExceeded } from "@/lib/runner/event-store";

describe("RecursionDepthExceeded", () => {
  it("exposes the depth that was exceeded", () => {
    const err = new RecursionDepthExceeded(5);
    expect(err.depth).toBe(5);
    expect(err.name).toBe("RecursionDepthExceeded");
    expect(err.message).toContain("5");
    expect(err.message).toContain("exceeded");
  });

  it("is an instance of Error", () => {
    const err = new RecursionDepthExceeded(4);
    expect(err).toBeInstanceOf(Error);
  });
});
