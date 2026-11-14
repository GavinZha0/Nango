import rawCatalog from "./market-catalog.json";

export interface McpMarketItem {
  id: string;
  name: string;
  category: string;
  description: string;
  type: "stdio" | "http" | "sse";
  url?: string;
  command: string | null;
  args: string[] | null;
  env: Record<string, string>;
  credentialEnvName: string | null;
  setupHint?: string;
}

export const MCP_MARKET_CATALOG: readonly McpMarketItem[] =
  rawCatalog as McpMarketItem[];

export const MCP_MARKET_CATEGORIES: readonly string[] = [
  "All",
  ...Array.from(new Set(MCP_MARKET_CATALOG.map((item) => item.category))),
];

/**
 * Filter curated MCP market items by search query and optional category.
 */
export function filterMarketCatalog(
  items: readonly McpMarketItem[],
  query: string,
  category: string = "All",
): McpMarketItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return items.filter((item) => {
    if (category !== "All" && item.category !== category) {
      return false;
    }
    if (!normalizedQuery) return true;
    return (
      item.name.toLowerCase().includes(normalizedQuery)
      || item.description.toLowerCase().includes(normalizedQuery)
      || item.category.toLowerCase().includes(normalizedQuery)
      || (item.command?.toLowerCase().includes(normalizedQuery) ?? false)
    );
  });
}
