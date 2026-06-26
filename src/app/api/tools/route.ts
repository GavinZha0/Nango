import "server-only";

import { NextResponse } from "next/server";
import { and, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { McpServerTable, CredentialTable } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";

// GET /api/tools
// Returns MCP servers, enabled LLM credentials (for agent editor),
// and enabled API credentials (for MCP server credential selector).

export const GET = withSession("/api/tools", async ({ session }) => {
  const userId = session.user.id;

  const credentialCols = {
    id: CredentialTable.id,
    name: CredentialTable.name,
    provider: CredentialTable.provider,
  } as const;

  const [mcpServers, llmCredentials, apiCredentials] = await Promise.all([
    db
      .select({
        id: McpServerTable.id,
        name: McpServerTable.name,
        description: McpServerTable.description,
        serverDescription: McpServerTable.serverDescription,
        serverInstructions: McpServerTable.serverInstructions,
        url: McpServerTable.url,
        enabled: McpServerTable.enabled,
      })
      .from(McpServerTable)
      .where(
        or(
          eq(McpServerTable.createdBy, userId),
          eq(McpServerTable.visibility, "public"),
        )
      ),

    // Enabled LLM credentials (for agent editor)
    db
      .select(credentialCols)
      .from(CredentialTable)
      .where(
        and(
          eq(CredentialTable.enabled, true),
          eq(CredentialTable.serviceType, "llm"),
        )
      )
      .orderBy(CredentialTable.name),

    // Enabled integration credentials (MCP servers, future SSH etc.)
    db
      .select(credentialCols)
      .from(CredentialTable)
      .where(
        and(
          eq(CredentialTable.enabled, true),
          eq(CredentialTable.serviceType, "integration"),
        )
      )
      .orderBy(CredentialTable.name),
  ]);

  return NextResponse.json({ mcpServers, llmCredentials, apiCredentials });
});
