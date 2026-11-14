import { describe, expect, it } from "vitest";

import {
  MCP_MARKET_CATALOG,
  MCP_MARKET_CATEGORIES,
  filterMarketCatalog,
} from "@/lib/mcp/market-catalog";

describe("mcp/market-catalog", () => {
  it("loads a valid non-empty curated catalog with unique ids", () => {
    expect(MCP_MARKET_CATALOG.length).toBeGreaterThanOrEqual(10);
    expect(MCP_MARKET_CATEGORIES[0]).toBe("All");

    const ids = new Set<string>();
    for (const item of MCP_MARKET_CATALOG) {
      expect(item.id.trim().length).toBeGreaterThan(0);
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);

      expect(item.name.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
      if (item.type === "stdio") {
        expect(item.command?.trim().length).toBeGreaterThan(0);
      } else {
        expect(item.url?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("filters by query and category", () => {
    const browserItems = filterMarketCatalog(MCP_MARKET_CATALOG, "", "Browser");
    expect(browserItems.length).toBeGreaterThanOrEqual(2);
    expect(browserItems.every((i) => i.category === "Browser")).toBe(true);

    const searchPlaywright = filterMarketCatalog(
      MCP_MARKET_CATALOG,
      "playwright",
      "All",
    );
    expect(searchPlaywright.map((i) => i.id)).toEqual(["playwright"]);

    const crossFilter = filterMarketCatalog(
      MCP_MARKET_CATALOG,
      "playwright",
      "Data",
    );
    expect(crossFilter).toHaveLength(0);
  });
});
