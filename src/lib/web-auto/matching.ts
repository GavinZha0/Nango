/**
 * Candidate MCP server with properties needed for Playwright matching.
 */
export interface PlaywrightServerCandidate {
  id: string;
  name: string;
  enabled?: boolean | null;
  visibility?: string | null;
}

/**
 * Shared heuristic to find the best Playwright MCP server candidate.
 *
 * Implements a prioritized matching strategy matching server-side discovery:
 * 1. Enabled public server with exact name ('playwright' | 'playwright-mcp')
 * 2. Enabled server (e.g. user's own private) with exact name ('playwright' | 'playwright-mcp')
 * 3. Enabled public server containing 'playwright' in its name
 * 4. Enabled server (any visibility) containing 'playwright' in its name
 * 5. If no enabled server matches, returns null (never auto-binds disabled servers)
 */
export function findBestPlaywrightMcpServer<T extends PlaywrightServerCandidate>(
  servers: readonly T[],
): T | null {
  if (!servers || servers.length === 0) return null;

  const isExact = (name: string): boolean => {
    const lower = name.trim().toLowerCase();
    return lower === "playwright" || lower === "playwright-mcp";
  };

  const isPartial = (name: string): boolean => {
    return name.trim().toLowerCase().includes("playwright");
  };

  // Only consider active/enabled servers (enabled !== false)
  const activeServers = servers.filter((s) => s.enabled !== false);

  // Tier 1: Enabled + Public + Exact
  const t1 = activeServers.find((s) => s.visibility === "public" && isExact(s.name));
  if (t1) return t1;

  // Tier 2: Enabled + Exact (e.g. user's own private enabled server)
  const t2 = activeServers.find((s) => isExact(s.name));
  if (t2) return t2;

  // Tier 3: Enabled + Public + Partial
  const t3 = activeServers.find((s) => s.visibility === "public" && isPartial(s.name));
  if (t3) return t3;

  // Tier 4: Enabled + Partial
  const t4 = activeServers.find((s) => isPartial(s.name));
  if (t4) return t4;

  return null;
}
