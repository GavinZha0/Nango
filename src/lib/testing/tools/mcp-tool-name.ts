import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";
import { buildMcpToolPrefix, toAgentToolName } from "@/lib/mcp/tool-namespace";

/**
 * Load a reusable prefix-stripper for one MCP server so batch case creation
 * queries `McpServerTable` at most once.
 */
export async function loadMcpPrefixStripper(
  mcpServerId: string | null | undefined,
): Promise<(toolName: string) => string> {
  if (!mcpServerId) return (toolName) => toolName;

  const [server] = await db
    .select({
      id: McpServerTable.id,
      name: McpServerTable.name,
      group: McpServerTable.group,
      tools: McpServerTable.tools,
    })
    .from(McpServerTable)
    .where(eq(McpServerTable.id, mcpServerId))
    .limit(1);

  if (!server) return (toolName) => toolName;

  const prefix = buildMcpToolPrefix({
    serverId: server.id,
    group: server.group,
    name: server.name,
  });
  const marker = `${prefix}_`;

  return (toolName: string) => {
    if (Array.isArray(server.tools)) {
      const matched = server.tools.find(
        (t) => t && typeof t.name === "string" && toAgentToolName(prefix, t.name) === toolName,
      );
      if (matched?.name) return matched.name;
    }

    if (toolName.startsWith(marker) && toolName.length > marker.length) {
      return toolName.slice(marker.length);
    }

    return toolName;
  };
}

/**
 * Strip the agent-facing MCP server prefix from `toolName` when storing
 * Verification cases so cases always persist the server's raw tool name.
 */
export async function stripMcpServerToolPrefix(
  mcpServerId: string | null | undefined,
  toolName: string,
): Promise<string> {
  const strip = await loadMcpPrefixStripper(mcpServerId);
  return strip(toolName);
}
