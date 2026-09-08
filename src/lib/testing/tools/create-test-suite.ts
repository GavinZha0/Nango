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

// CONTRACT: permissive object parsing strips unknown fields to tolerate LLM hallucinated extra keys.
export const createTestSuiteSchema = z
  .object({
    category: z
      .enum(["verification", "evaluation", "web-auto"])
      .describe("Target test category ('verification', 'evaluation', or 'web-auto')."),
    name: suiteNameSchema,
    description: suiteDescriptionSchema,
    mcpServerId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Target MCP Server ID. Required for 'verification'; optional for 'web-auto' (auto-discovers shared Playwright server if omitted).",
      ),
    agentId: z
      .string()
      .min(1)
      .optional()
      .describe("Target Agent ID to be evaluated (required for 'evaluation')."),
    agentSource: z
      .enum(["builtin", "backend"])
      .optional()
      .describe("Source platform of the agent ('builtin' or 'backend', evaluation only). Defaults to 'builtin'."),
    evaluatorAgentId: z
      .string()
      .uuid()
      .optional()
      .describe("Optional Evaluator Agent ID to judge conversational quality (evaluation only)."),
  })
  .superRefine((val, ctx) => {
    if (val.category === "verification") {
      if (!val.mcpServerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'mcpServerId' (UUID) is required for 'verification' suites to target an MCP server.",
          path: ["mcpServerId"],
        });
      }
      if (val.agentId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'agentId' is not permitted in 'verification' suites. Verification suites test MCP servers; provide 'mcpServerId' instead.",
          path: ["agentId"],
        });
      }
      if (val.agentSource !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'agentSource' is not permitted in 'verification' suites. Agent source is exclusive to 'evaluation'.",
          path: ["agentSource"],
        });
      }
      if (val.evaluatorAgentId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'evaluatorAgentId' is not permitted in 'verification' suites. Evaluator agents are exclusive to 'evaluation'.",
          path: ["evaluatorAgentId"],
        });
      }
    } else if (val.category === "evaluation") {
      if (!val.agentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'agentId' is required for 'evaluation' suites to identify the target agent being evaluated.",
          path: ["agentId"],
        });
      }
      if (val.mcpServerId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'mcpServerId' is not permitted in 'evaluation' suites. Evaluation suites test agents; provide 'agentId' instead.",
          path: ["mcpServerId"],
        });
      }
    } else if (val.category === "web-auto") {
      if (val.agentId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'agentId' is not permitted in 'web-auto' suites. Web-auto suites execute Playwright browser tests; bind 'mcpServerId' or leave omitted for auto-discovery.",
          path: ["agentId"],
        });
      }
      if (val.agentSource !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'agentSource' is not permitted in 'web-auto' suites. Agent source is exclusive to 'evaluation'.",
          path: ["agentSource"],
        });
      }
      if (val.evaluatorAgentId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Field 'evaluatorAgentId' is not permitted in 'web-auto' suites. Evaluator agents are exclusive to 'evaluation'.",
          path: ["evaluatorAgentId"],
        });
      }
    }
  });

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
        if (!mcpServerId) {
          throw new Error("Field 'mcpServerId' is required for verification suites.");
        }

        const [serverRow] = await db
          .select({
            id: McpServerTable.id,
            name: McpServerTable.name,
            serverTitle: McpServerTable.serverTitle,
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
              mcpServerName: serverRow.serverTitle || serverRow.name,
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
        if (!agentId) {
          throw new Error("Field 'agentId' is required for evaluation suites.");
        }

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
