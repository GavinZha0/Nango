import "server-only";

import { z } from "zod";
import { and, eq, ilike } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  EvalSuiteTable,
  WebAutoSuiteTable,
  McpServerTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type CreateTestSuiteResult,
  type SuiteSummaryItem,
  type TesterToolContext,
} from "../types";
import { isUniqueViolation } from "@/lib/http/validation";

export const createTestSuiteSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP/Workflow), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Unique, descriptive name for the new test suite."),
  description: z
    .string()
    .max(1000)
    .optional()
    .describe("Optional summary of what this suite tests."),

  // Verification specific
  serverId: z
    .string()
    .uuid()
    .optional()
    .describe("Target MCP Server ID to be tested (required for verification category)."),

  // Evaluation specific
  agentId: z
    .string()
    .min(1)
    .optional()
    .describe("Target Agent ID to be evaluated (required for evaluation category)."),
  agentSource: z
    .enum(["builtin", "backend"])
    .default("builtin")
    .optional()
    .describe("Source platform of the agent. Defaults to 'builtin'."),
  evaluatorAgentId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional Evaluator Agent ID to judge conversational quality."),
});

export function buildCreateTestSuiteTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "create_test_suite",
    description: [
      "Create a new test suite under 'verification', 'evaluation', or 'web-auto'.",
      "Verification suites require serverId (target MCP server). Evaluation suites require agentId (target agent).",
      "Web-auto suites automatically discover the active Playwright execution environment.",
    ].join(" "),
    parameters: createTestSuiteSchema,
    execute: async ({
      category,
      name,
      description,
      serverId,
      agentId,
      agentSource,
      evaluatorAgentId,
    }): Promise<CreateTestSuiteResult> => {
      if (category === "verification") {
        if (!serverId) {
          throw new Error("'serverId' (target MCP server ID) is required when creating a verification suite.");
        }

        const [serverRow] = await db
          .select({ id: McpServerTable.id, name: McpServerTable.name })
          .from(McpServerTable)
          .where(eq(McpServerTable.id, serverId))
          .limit(1);

        if (!serverRow) {
          throw new Error(`MCP Server '${serverId}' not found.`);
        }

        try {
          const [inserted] = await db
            .insert(VerificationSuiteTable)
            .values({
              name,
              description: description ?? null,
              category: "mcp",
              mcpServerId: serverId,
              enabled: true,
              visibility: "private",
              timeoutSec: 300,
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
            })
            .returning();

          if (!inserted) {
            throw new Error("Failed to create verification suite.");
          }

          const suite: SuiteSummaryItem = {
            id: inserted.id,
            name: inserted.name,
            description: inserted.description ?? null,
            serverId: inserted.mcpServerId ?? null,
            serverName: serverRow.name,
            caseCount: 0,
            enabled: Boolean(inserted.enabled),
            visibility: inserted.visibility as "private" | "public",
          };

          return { category, suite };
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new Error(`A verification suite named '${name}' already exists.`);
          }
          throw err;
        }
      }

      if (category === "evaluation") {
        if (!agentId) {
          throw new Error("'agentId' (target Agent ID) is required when creating an evaluation suite.");
        }

        try {
          const [inserted] = await db
            .insert(EvalSuiteTable)
            .values({
              name,
              description: description ?? null,
              agentId,
              agentSource: agentSource ?? "builtin",
              evaluatorAgentId: evaluatorAgentId ?? null,
              enabled: true,
              visibility: "private",
              createdBy: ctx.userId,
            })
            .returning();

          if (!inserted) {
            throw new Error("Failed to create evaluation suite.");
          }

          const suite: SuiteSummaryItem = {
            id: inserted.id,
            name: inserted.name,
            description: inserted.description ?? null,
            agentId: inserted.agentId ?? null,
            agentSource: inserted.agentSource ?? null,
            evaluatorAgentId: inserted.evaluatorAgentId ?? null,
            caseCount: 0,
            enabled: Boolean(inserted.enabled),
            visibility: inserted.visibility as "private" | "public",
          };

          return { category, suite };
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new Error(`An evaluation suite named '${name}' already exists for this agent.`);
          }
          throw err;
        }
      }

      if (category === "web-auto") {
        // Auto-discover active Playwright MCP server execution tool
        const [playwrightServer] = await db
          .select({ id: McpServerTable.id })
          .from(McpServerTable)
          .where(
            and(
              ilike(McpServerTable.name, "%playwright%"),
              eq(McpServerTable.enabled, true),
            ),
          )
          .limit(1);

        try {
          const [inserted] = await db
            .insert(WebAutoSuiteTable)
            .values({
              name,
              description: description ?? null,
              mcpServerId: playwrightServer?.id ?? null,
              timeoutSec: 300,
              enabled: true,
              visibility: "private",
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
            })
            .returning();

          if (!inserted) {
            throw new Error("Failed to create web-auto suite.");
          }

          const suite: SuiteSummaryItem = {
            id: inserted.id,
            name: inserted.name,
            description: inserted.description ?? null,
            mcpServerId: inserted.mcpServerId ?? null,
            timeoutSec: inserted.timeoutSec ?? 300,
            caseCount: 0,
            enabled: Boolean(inserted.enabled),
            visibility: inserted.visibility as "private" | "public",
          };

          return { category, suite };
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new Error(`A web-auto suite named '${name}' already exists.`);
          }
          throw err;
        }
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
