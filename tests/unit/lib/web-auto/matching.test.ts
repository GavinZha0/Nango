import { describe, it, expect } from "vitest";
import { findBestPlaywrightMcpServer } from "@/lib/web-auto/matching";

describe("findBestPlaywrightMcpServer heuristic", () => {
  it("returns null when servers array is empty", () => {
    expect(findBestPlaywrightMcpServer([])).toBeNull();
  });

  it("never binds disabled servers", () => {
    const servers = [
      { id: "s1", name: "playwright", enabled: false, visibility: "public" },
      { id: "s2", name: "playwright-mcp", enabled: false, visibility: "private" },
      { id: "s3", name: "my-playwright", enabled: false },
    ];
    expect(findBestPlaywrightMcpServer(servers)).toBeNull();
  });

  it("prefers enabled public exact match ('playwright' or 'playwright-mcp') over partial match", () => {
    const servers = [
      { id: "partial-1", name: "playwright-browser-service", enabled: true, visibility: "public" },
      { id: "exact-pub", name: "playwright", enabled: true, visibility: "public" },
    ];
    const match = findBestPlaywrightMcpServer(servers);
    expect(match?.id).toBe("exact-pub");
  });

  it("matches exact 'playwright-mcp' with high priority", () => {
    const servers = [
      { id: "partial", name: "my-playwright", enabled: true, visibility: "public" },
      { id: "exact-mcp", name: "playwright-mcp", enabled: true, visibility: "public" },
    ];
    const match = findBestPlaywrightMcpServer(servers);
    expect(match?.id).toBe("exact-mcp");
  });

  it("prefers enabled public exact match over enabled private exact match", () => {
    const servers = [
      { id: "priv-exact", name: "playwright", enabled: true, visibility: "private" },
      { id: "pub-exact", name: "playwright", enabled: true, visibility: "public" },
    ];
    const match = findBestPlaywrightMcpServer(servers);
    expect(match?.id).toBe("pub-exact");
  });

  it("falls back to user's private enabled exact match if no public exact exists", () => {
    const servers = [
      { id: "priv-exact", name: "playwright", enabled: true, visibility: "private" },
      { id: "pub-partial", name: "playwright-cluster", enabled: true, visibility: "public" },
    ];
    const match = findBestPlaywrightMcpServer(servers);
    expect(match?.id).toBe("priv-exact");
  });

  it("matches partial name when no exact match exists, preferring public", () => {
    const servers = [
      { id: "priv-partial", name: "user-playwright-env", enabled: true, visibility: "private" },
      { id: "pub-partial", name: "shared-playwright-pool", enabled: true, visibility: "public" },
    ];
    const match = findBestPlaywrightMcpServer(servers);
    expect(match?.id).toBe("pub-partial");
  });

  it("matches private partial name when no public partial exists", () => {
    const servers = [
      { id: "priv-partial", name: "user-playwright-env", enabled: true, visibility: "private" },
      { id: "other-server", name: "github-mcp", enabled: true, visibility: "public" },
    ];
    const match = findBestPlaywrightMcpServer(servers);
    expect(match?.id).toBe("priv-partial");
  });
});
