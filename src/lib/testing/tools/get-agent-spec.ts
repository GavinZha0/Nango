import "server-only";

import { z } from "zod";
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  BuiltinAgentToolTable,
  SkillTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";
import type { TesterToolContext, GetAgentSpecResult } from "../types";

export const getAgentSpecSchema = z.object({
  agentId: z
    .string()
    .uuid()
    .describe("The unique UUID of the target agent to inspect."),
});

export function buildGetAgentSpecTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "get_agent_spec",
    description: [
      "Retrieve the specification of an AI agent, including its system prompt, model configuration, persona, and bound tools/skills.",
      "Use this to understand the agent's expected behavior and capabilities before authoring evaluation test cases.",
    ].join(" "),
    parameters: getAgentSpecSchema,
    execute: async ({ agentId }): Promise<GetAgentSpecResult> => {
      const visible = await isAgentVisibleTo(agentId, ctx.userId);
      if (!visible) {
        throw new Error(`Target agent '${agentId}' not found or access denied.`);
      }

      const [agentRow] = await db
        .select({
          id: BuiltinAgentTable.id,
          name: BuiltinAgentTable.name,
          description: BuiltinAgentTable.description,
          role: BuiltinAgentTable.role,
          model: BuiltinAgentTable.model,
          modelProvider: BuiltinAgentTable.modelProvider,
          prompt: BuiltinAgentTable.prompt,
        })
        .from(BuiltinAgentTable)
        .where(eq(BuiltinAgentTable.id, agentId))
        .limit(1);

      if (!agentRow) {
        throw new Error(`Target agent '${agentId}' not found.`);
      }

      const toolRows = await db
        .select({
          toolType: BuiltinAgentToolTable.toolType,
          builtinTool: BuiltinAgentToolTable.builtinTool,
          mcpToolName: BuiltinAgentToolTable.mcpToolName,
          skillSlug: SkillTable.name,
        })
        .from(BuiltinAgentToolTable)
        .leftJoin(SkillTable, eq(BuiltinAgentToolTable.skillId, SkillTable.id))
        .where(eq(BuiltinAgentToolTable.agentId, agentId))
        .orderBy(asc(BuiltinAgentToolTable.order));

      const boundTools: string[] = [];
      const boundSkills: string[] = [];

      for (const tr of toolRows) {
        if (tr.toolType === "skill" && tr.skillSlug) {
          boundSkills.push(tr.skillSlug);
        } else if (tr.toolType === "builtin_tool" && tr.builtinTool) {
          boundTools.push(tr.builtinTool);
        } else if (tr.toolType === "mcp_tool" && tr.mcpToolName) {
          boundTools.push(tr.mcpToolName);
        } else if (tr.toolType) {
          boundTools.push(tr.toolType);
        }
      }

      return {
        agentId: agentRow.id,
        name: agentRow.name,
        description: agentRow.description ?? null,
        role: agentRow.role ?? null,
        model: agentRow.model,
        modelProvider: agentRow.modelProvider,
        systemPrompt: agentRow.prompt ?? null,
        tools: boundTools,
        skills: boundSkills,
      };
    },
  });
}
