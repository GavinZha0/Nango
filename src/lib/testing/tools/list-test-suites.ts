import "server-only";

import { z } from "zod";
import { and, asc, eq, or, sql } from "drizzle-orm";

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
  type ListTestSuitesResult,
  type SuiteSummaryItem,
  type TesterToolContext,
} from "../types";

export const listTestSuitesSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  suiteId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional suite ID to filter for a specific test suite."),
  enabledOnly: z
    .boolean()
    .default(false)
    .describe("If true, only returns enabled suites. Defaults to false."),
});

export function buildListTestSuitesTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "list_test_suites",
    description: [
      "List test suites for a specified category ('verification', 'evaluation', or 'web-auto').",
      "Returns high-level metadata (ID, name, description, target mapping, caseCount, and enabled status).",
      "Use this tool first to discover relevant test suites before inspecting or executing cases.",
    ].join(" "),
    parameters: listTestSuitesSchema,
    execute: async ({ category, suiteId, enabledOnly }): Promise<ListTestSuitesResult> => {
      let suites: SuiteSummaryItem[] = [];

      if (category === "verification") {
        const rows = await db
          .select({
            id: VerificationSuiteTable.id,
            name: VerificationSuiteTable.name,
            description: VerificationSuiteTable.description,
            mcpServerId: VerificationSuiteTable.mcpServerId,
            serverName: McpServerTable.name,
            caseCount: sql<number>`(
              select count(*)::int from "verification_case"
              where "verification_case"."suite_id" = "verification_suite"."id"
            )`,
            enabled: VerificationSuiteTable.enabled,
            visibility: VerificationSuiteTable.visibility,
          })
          .from(VerificationSuiteTable)
          .leftJoin(
            McpServerTable,
            eq(VerificationSuiteTable.mcpServerId, McpServerTable.id),
          )
          .where(
            and(
              eq(VerificationSuiteTable.category, "mcp"),
              suiteId ? eq(VerificationSuiteTable.id, suiteId) : undefined,
              enabledOnly ? eq(VerificationSuiteTable.enabled, true) : undefined,
              ctx.isAdmin
                ? undefined
                : or(
                    eq(VerificationSuiteTable.visibility, "public"),
                    eq(VerificationSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .orderBy(asc(VerificationSuiteTable.name));

        suites = rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description ?? null,
          mcpServerId: r.mcpServerId ?? null,
          serverName: r.serverName ?? null,
          caseCount: Number(r.caseCount ?? 0),
          enabled: Boolean(r.enabled),
          visibility: r.visibility as "private" | "public",
        }));
      } else if (category === "evaluation") {
        const rows = await db
          .select({
            id: EvalSuiteTable.id,
            name: EvalSuiteTable.name,
            description: EvalSuiteTable.description,
            agentId: EvalSuiteTable.agentId,
            agentSource: EvalSuiteTable.agentSource,
            evaluatorAgentId: EvalSuiteTable.evaluatorAgentId,
            caseCount: sql<number>`(
              select count(*)::int from "eval_case"
              where "eval_case"."suite_id" = "eval_suite"."id"
            )`,
            enabled: EvalSuiteTable.enabled,
            visibility: EvalSuiteTable.visibility,
          })
          .from(EvalSuiteTable)
          .where(
            and(
              suiteId ? eq(EvalSuiteTable.id, suiteId) : undefined,
              enabledOnly ? eq(EvalSuiteTable.enabled, true) : undefined,
              ctx.isAdmin
                ? undefined
                : or(
                    eq(EvalSuiteTable.visibility, "public"),
                    eq(EvalSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .orderBy(asc(EvalSuiteTable.name));

        suites = rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description ?? null,
          agentId: r.agentId ?? null,
          agentSource: r.agentSource ?? null,
          evaluatorAgentId: r.evaluatorAgentId ?? null,
          caseCount: Number(r.caseCount ?? 0),
          enabled: Boolean(r.enabled),
          visibility: r.visibility as "private" | "public",
        }));
      } else if (category === "web-auto") {
        const rows = await db
          .select({
            id: WebAutoSuiteTable.id,
            name: WebAutoSuiteTable.name,
            description: WebAutoSuiteTable.description,
            mcpServerId: WebAutoSuiteTable.mcpServerId,
            timeoutSec: WebAutoSuiteTable.timeoutSec,
            caseCount: sql<number>`(
              select count(*)::int from "web_auto_case"
              where "web_auto_case"."suite_id" = "web_auto_suite"."id"
            )`,
            enabled: WebAutoSuiteTable.enabled,
            visibility: WebAutoSuiteTable.visibility,
          })
          .from(WebAutoSuiteTable)
          .where(
            and(
              suiteId ? eq(WebAutoSuiteTable.id, suiteId) : undefined,
              enabledOnly ? eq(WebAutoSuiteTable.enabled, true) : undefined,
              ctx.isAdmin
                ? undefined
                : or(
                    eq(WebAutoSuiteTable.visibility, "public"),
                    eq(WebAutoSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .orderBy(asc(WebAutoSuiteTable.name));

        suites = rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description ?? null,
          mcpServerId: r.mcpServerId ?? null,
          timeoutSec: r.timeoutSec ?? null,
          caseCount: Number(r.caseCount ?? 0),
          enabled: Boolean(r.enabled),
          visibility: r.visibility as "private" | "public",
        }));
      }

      return {
        category,
        total: suites.length,
        suites,
      };
    },
  });
}
