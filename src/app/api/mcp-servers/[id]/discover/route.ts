import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { McpServerTable, type McpToolSnapshot } from "@/lib/db/schema";
import { withEditor } from "@/lib/http/route-handlers";
import { withMcpAdminClient } from "@/lib/mcp/admin-client.server";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp-servers/[id]/discover
 */
export const POST = withEditor<{ id: string }>(
  "/api/mcp-servers/[id]/discover",
  async ({ params }) => {
    const updated = await withMcpAdminClient({
      serverId: params.id,
      clientName: "nango-discover",
      errorPrefix: "Failed to discover tools",
      fn: async ({ client, server }) => {
        // Server metadata observed during the `initialize` handshake
        // (already completed by client.connect). The SDK exposes it
        // via these methods — fields may be undefined on older
        // servers / older protocol revisions.
        const serverInfo = client.getServerVersion();
        const instructions = client.getInstructions();
        const result = await client.listTools();

        // Preserve the existing per-tool `enabled` flag across re-discovery
        // so admins do not have to re-tick after every refresh.
        const existingTools = new Map(
          (server.tools ?? []).map((t) => [t.name, t.enabled]),
        );
        const tools: McpToolSnapshot[] = (result.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Record<string, unknown> | undefined,
          enabled: existingTools.get(t.name) ?? true,
        }));

        // Newer MCP spec revisions expose `title` / `description`
        // in serverInfo; older SDKs typed them only loosely. Cast
        // through an extension type to keep the persist call typed.
        const info = serverInfo as
          | {
              name: string;
              version: string;
              title?: string;
              description?: string;
            }
          | undefined;

        // Pass null (not undefined) for missing fields so a
        // previously-populated row clears on a server downgrade or
        // config swap.
        const [row] = await db
          .update(McpServerTable)
          .set({
            tools,
            serverName: info?.name ?? null,
            serverVersion: info?.version ?? null,
            serverTitle: info?.title ?? null,
            serverDescription: info?.description ?? null,
            serverInstructions: instructions ?? null,
            updatedAt: new Date(),
          })
          .where(eq(McpServerTable.id, server.id))
          .returning();
        return row;
      },
    });

    return NextResponse.json(updated);
  },
);
