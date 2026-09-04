import "server-only";

import { z } from "zod";
import { and, asc, eq, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  VerificationCaseTable,
  EvalSuiteTable,
  EvalCaseTable,
  WebAutoSuiteTable,
  WebAutoCaseTable,
  McpServerTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type CaseSummaryItem,
  type SuiteSummaryItem,
  type TesterToolContext,
  type TestSuiteDetailsResult,
} from "../types";

export const getTestSuiteDetailsSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  suiteId: z
    .string()
    .uuid()
    .describe("The unique ID of the test suite to inspect."),
});

export function buildGetTestSuiteDetailsTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "get_test_suite_details",
    description: [
      "Get detailed configuration and case topology for a specific test suite.",
      "Returns the suite metadata along with an array of lightweight case summaries (id, name, enabled, assertionCount).",
      "Use this tool to inspect the test coverage and inventory of a suite before executing or modifying cases.",
    ].join(" "),
    parameters: getTestSuiteDetailsSchema,
    execute: async ({ category, suiteId }): Promise<TestSuiteDetailsResult> => {
      if (category === "verification") {
        const [suiteRow] = await db
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
              eq(VerificationSuiteTable.id, suiteId),
              ctx.isAdmin
                ? undefined
                : or(
                    eq(VerificationSuiteTable.visibility, "public"),
                    eq(VerificationSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .limit(1);

        if (!suiteRow) {
          throw new Error(`Verification suite '${suiteId}' not found or access denied.`);
        }

        const caseRows = await db
          .select({
            id: VerificationCaseTable.id,
            name: VerificationCaseTable.name,
            toolName: VerificationCaseTable.toolName,
            enabled: VerificationCaseTable.enabled,
            assertions: VerificationCaseTable.assertions,
          })
          .from(VerificationCaseTable)
          .where(eq(VerificationCaseTable.suiteId, suiteId))
          .orderBy(asc(VerificationCaseTable.name));

        const suite: SuiteSummaryItem = {
          id: suiteRow.id,
          name: suiteRow.name,
          description: suiteRow.description ?? null,
          mcpServerId: suiteRow.mcpServerId ?? null,
          serverName: suiteRow.serverName ?? null,
          caseCount: Number(suiteRow.caseCount ?? 0),
          enabled: Boolean(suiteRow.enabled),
          visibility: suiteRow.visibility as "private" | "public",
        };

        const cases: CaseSummaryItem[] = caseRows.map((c) => ({
          id: c.id,
          name: c.name,
          toolName: c.toolName ?? null,
          enabled: Boolean(c.enabled),
          assertionCount: Array.isArray(c.assertions) ? c.assertions.length : 0,
        }));

        return { category, suite, cases };
      }

      if (category === "evaluation") {
        const [suiteRow] = await db
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
              eq(EvalSuiteTable.id, suiteId),
              ctx.isAdmin
                ? undefined
                : or(
                    eq(EvalSuiteTable.visibility, "public"),
                    eq(EvalSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .limit(1);

        if (!suiteRow) {
          throw new Error(`Evaluation suite '${suiteId}' not found or access denied.`);
        }

        const caseRows = await db
          .select({
            id: EvalCaseTable.id,
            name: EvalCaseTable.name,
            enabled: EvalCaseTable.enabled,
            assertions: EvalCaseTable.assertions,
          })
          .from(EvalCaseTable)
          .where(eq(EvalCaseTable.suiteId, suiteId))
          .orderBy(asc(EvalCaseTable.name));

        const suite: SuiteSummaryItem = {
          id: suiteRow.id,
          name: suiteRow.name,
          description: suiteRow.description ?? null,
          agentId: suiteRow.agentId ?? null,
          agentSource: suiteRow.agentSource ?? null,
          evaluatorAgentId: suiteRow.evaluatorAgentId ?? null,
          caseCount: Number(suiteRow.caseCount ?? 0),
          enabled: Boolean(suiteRow.enabled),
          visibility: suiteRow.visibility as "private" | "public",
        };

        const cases: CaseSummaryItem[] = caseRows.map((c) => ({
          id: c.id,
          name: c.name,
          enabled: Boolean(c.enabled),
          assertionCount: Array.isArray(c.assertions) ? c.assertions.length : 0,
        }));

        return { category, suite, cases };
      }

      if (category === "web-auto") {
        const [suiteRow] = await db
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
              eq(WebAutoSuiteTable.id, suiteId),
              ctx.isAdmin
                ? undefined
                : or(
                    eq(WebAutoSuiteTable.visibility, "public"),
                    eq(WebAutoSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .limit(1);

        if (!suiteRow) {
          throw new Error(`Web Auto suite '${suiteId}' not found or access denied.`);
        }

        const caseRows = await db
          .select({
            id: WebAutoCaseTable.id,
            name: WebAutoCaseTable.name,
            enabled: WebAutoCaseTable.enabled,
            assertions: WebAutoCaseTable.assertions,
          })
          .from(WebAutoCaseTable)
          .where(eq(WebAutoCaseTable.suiteId, suiteId))
          .orderBy(asc(WebAutoCaseTable.name));

        const suite: SuiteSummaryItem = {
          id: suiteRow.id,
          name: suiteRow.name,
          description: suiteRow.description ?? null,
          mcpServerId: suiteRow.mcpServerId ?? null,
          timeoutSec: suiteRow.timeoutSec ?? null,
          caseCount: Number(suiteRow.caseCount ?? 0),
          enabled: Boolean(suiteRow.enabled),
          visibility: suiteRow.visibility as "private" | "public",
        };

        const cases: CaseSummaryItem[] = caseRows.map((c) => ({
          id: c.id,
          name: c.name,
          enabled: Boolean(c.enabled),
          assertionCount: Array.isArray(c.assertions) ? c.assertions.length : 0,
        }));

        return { category, suite, cases };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
