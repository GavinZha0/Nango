import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAgnoEntitiesServer } from "@/lib/backends/agno/entity.server";
import { fetchDifyEntitiesServer } from "@/lib/backends/dify/entity.server";
import { fetchMastraEntitiesServer } from "@/lib/backends/mastra/entity.server";

describe("Entity fetchers timeout handling", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchAgnoEntitiesServer gracefully catches TimeoutError and returns error without hanging", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    globalThis.fetch = fetchMock;

    const result = await fetchAgnoEntitiesServer(
      "cred-1",
      "https://agno.example",
      "test-token",
    );

    expect(result.entities).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("Connection timed out (5s)");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
  });

  it("fetchDifyEntitiesServer gracefully catches TimeoutError and returns error without hanging", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    globalThis.fetch = fetchMock;

    const result = await fetchDifyEntitiesServer(
      "cred-2",
      "https://dify.example",
      "test-token",
    );

    expect(result.entities).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toContain("Connection timed out (5s)");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
  });

  it("fetchMastraEntitiesServer gracefully catches TimeoutError and returns error without hanging", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    globalThis.fetch = fetchMock;

    const result = await fetchMastraEntitiesServer(
      "cred-3",
      "https://mastra.example",
      "test-token",
    );

    expect(result.entities).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toContain("Connection timed out (5s)");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
  });
});
