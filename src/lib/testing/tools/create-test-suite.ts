import "server-only";

import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  EvalSuiteTable,
  WebAutoSuiteTable,
  McpServerTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  type CreateTestSuiteResult,
  type SuiteSummaryItem,
  type TesterToolContext,
} from "../types";
import { canViewResource } from "@/lib/auth/permissions";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";
import { isUniqueViolation } from "@/lib/http/validation";
import { discoverPublicPlaywrightMcpServer } from "@/lib/web-auto/discovery.server";

const suiteNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Unique, descriptive name for the new test suite.");
const suiteDescriptionSchema = z
  .string()
  .max(1000)
  .optional()
  .describe("Optional summary of what this suite tests.");

export const createTestSuiteSchema = z.discriminatedUnion("category", [
  z.object({
    category: z.literal("verification"),
    name: suiteNameSchema,
    description: suiteDescriptionSchema,
    mcpServerId: z.string().uuid().describe("Target MCP Server ID to be tested."),
  }).strict(),
  z.object({
    category: z.literal("evaluation"),
    name: suiteNameSchema,
    description: suiteDescriptionSchema,
    agentId: z.string().min(1).describe("Target Agent ID to be evaluated."),
    agentSource: z
      .enum(["builtin", "backend"])
      .optional()
      .describe("Source platform of the agent. Defaults to 'builtin'."),
    evaluatorAgentId: z
      .string()
      .uuid()
      .optional()
      .describe("Optional Evaluator Agent ID to judge conversational quality."),
  }).strict(),
  z.object({
    category: z.literal("web-auto"),
    name: suiteNameSchema,
    description: suiteDescriptionSchema,
    mcpServerId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Target MCP Server ID. When omitted, auto-discovers the shared public Playwright server.",
      ),
  }).strict(),
]);

export function buildCreateTestSuiteTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "create_test_suite",
    description: [
      "Create a new test suite under 'verification', 'evaluation', or 'web-auto'.",
      "Verification suites require mcpServerId (target MCP server). Evaluation suites require agentId (target agent).",
      "Web-auto suites auto-discover the shared public Playwright server, or bind an explicitly provided mcpServerId.",
    ].join(" "),
    parameters: createTestSuiteSchema,
    execute: async (params): Promise<CreateTestSuiteResult> => {
      const { name, description, category } = params;
      if (!ctx.isEditor && !ctx.isAdmin) {
        throw new Error("Permission denied: Editor or admin role required to create test suites.");
      }
      if (params.category === "verification") {
        const mcpServerId = params.mcpServerId;

        const [serverRow] = await db
          .select({
            id: McpServerTable.id,
            name: McpServerTable.name,
            visibility: McpServerTable.visibility,
            createdBy: McpServerTable.createdBy,
          })
          .from(McpServerTable)
          .where(eq(McpServerTable.id, mcpServerId))
          .limit(1);

        const serverRBAC = {
          source: "local" as const,
          visibility: serverRow?.visibility as "private" | "public",
          createdBy: serverRow?.createdBy ?? null,
        };

        if (!serverRow || !canViewResource(serverRBAC, ctx)) {
          throw new Error(`MCP Server '${mcpServerId}' not found or access denied.`);
        }

        try {
          const [inserted] = await db
            .insert(VerificationSuiteTable)
            .values({
              name,
              description: description ?? null,
              category: "mcp",
              mcpServerId: mcpServerId,
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
            mcpServerId: inserted.mcpServerId ?? null,
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

      if (params.category === "evaluation") {
        const { agentId, agentSource, evaluatorAgentId } = params;

        const effectiveSource = agentSource ?? "builtin";
        if (effectiveSource === "builtin") {
          const visible = await isAgentVisibleTo(agentId, ctx.userId);
          if (!visible) {
            throw new Error(`Target agent '${agentId}' not found or access denied.`);
          }
        }

        if (evaluatorAgentId) {
          const evalVisible = await isAgentVisibleTo(evaluatorAgentId, ctx.userId);
          if (!evalVisible) {
            throw new Error(`Evaluator agent '${evaluatorAgentId}' not found or access denied.`);
          }
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

      if (params.category === "web-auto") {
        const mcpServerId = params.mcpServerId;
        // Resolve the Playwright MCP server binding:
        //  - explicit mcpServerId → validate visibility (public or own private)
        //  - otherwise → auto-discover the shared PUBLIC Playwright server;
        //    leave null when none is configured so the user can pick later.
        let boundMcpServerId: string | null = null;

        if (mcpServerId) {
          const [serverRow] = await db
            .select({
              id: McpServerTable.id,
              visibility: McpServerTable.visibility,
              createdBy: McpServerTable.createdBy,
            })
            .from(McpServerTable)
            .where(eq(McpServerTable.id, mcpServerId))
            .limit(1);

          const serverRBAC = {
            source: "local" as const,
            visibility: serverRow?.visibility as "private" | "public",
            createdBy: serverRow?.createdBy ?? null,
          };

          if (!serverRow || !canViewResource(serverRBAC, ctx)) {
            throw new Error(`MCP Server '${mcpServerId}' not found or access denied.`);
          }
          boundMcpServerId = mcpServerId;
        } else {
          boundMcpServerId = await discoverPublicPlaywrightMcpServer();
        }

        try {
          const [inserted] = await db
            .insert(WebAutoSuiteTable)
            .values({
              name,
              description: description ?? null,
              mcpServerId: boundMcpServerId,
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
