import "server-only";

import { z } from "zod";
import { and, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { McpServerTable, type McpToolSnapshot } from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import type { TesterToolContext, GetMcpToolSchemaResult } from "../types";

export const getMcpToolSchemaSchema = z.object({
  mcpServerId: z
    .string()
    .uuid()
    .describe("The unique UUID of the MCP server."),
  toolName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional: specific tool name to inspect within the MCP server. When provided, returns detailed inputSchema for this single tool. When omitted, returns all tools in the server.",
    ),
});

export function buildGetMcpToolSchemaTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "get_mcp_tool_schema",
    description: [
      "Retrieve the input schema (parameters, types, required fields) and description of tools within an MCP server.",
      "Specify 'mcpServerId' (obtained from suite.mcpServerId or server list).",
      "Optionally specify 'toolName' to inspect only a single tool's schema, which saves tokens.",
    ].join(" "),
    parameters: getMcpToolSchemaSchema,
    execute: async ({ mcpServerId, toolName }): Promise<GetMcpToolSchemaResult> => {
      const [serverRow] = await db
        .select({
          id: McpServerTable.id,
          name: McpServerTable.name,
          serverTitle: McpServerTable.serverTitle,
          serverDescription: McpServerTable.serverDescription,
          instructions: McpServerTable.serverInstructions,
          tools: McpServerTable.tools,
          visibility: McpServerTable.visibility,
          createdBy: McpServerTable.createdBy,
        })
        .from(McpServerTable)
        .where(
          and(
            eq(McpServerTable.id, mcpServerId),
            ctx.isAdmin
              ? undefined
              : or(
                  eq(McpServerTable.visibility, "public"),
                  eq(McpServerTable.createdBy, ctx.userId),
                ),
          ),
        )
        .limit(1);

      if (!serverRow) {
        throw new Error(`MCP Server '${mcpServerId}' not found or access denied.`);
      }

      const rawTools: McpToolSnapshot[] = Array.isArray(serverRow.tools)
        ? serverRow.tools
        : [];

      if (toolName) {
        const matched = rawTools.find((t) => t.name === toolName);
        if (!matched) {
          const available = rawTools.map((t) => t.name).join(", ");
          throw new Error(
            `Tool '${toolName}' not found in MCP Server '${serverRow.name}'. Available tools: [${available}]`,
          );
        }
        return {
          mcpServerId: serverRow.id,
          serverName: serverRow.name,
          serverTitle: serverRow.serverTitle ?? null,
          serverDescription: serverRow.serverDescription ?? null,
          instructions: serverRow.instructions ?? null,
          tool: {
            name: matched.name,
            description: matched.description ?? null,
            inputSchema: (matched.input_schema ?? {}) as Record<string, unknown>,
            enabled: Boolean(matched.enabled),
          },
        };
      }

      return {
        mcpServerId: serverRow.id,
        serverName: serverRow.name,
        serverTitle: serverRow.serverTitle ?? null,
        serverDescription: serverRow.serverDescription ?? null,
        instructions: serverRow.instructions ?? null,
        toolCount: rawTools.length,
        tools: rawTools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          inputSchema: (t.input_schema ?? {}) as Record<string, unknown>,
          enabled: Boolean(t.enabled),
        })),
      };
    },
  });
}
