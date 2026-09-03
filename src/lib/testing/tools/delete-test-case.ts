import "server-only";

import { z } from "zod";
import { and, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  VerificationCaseTable,
  EvalSuiteTable,
  EvalCaseTable,
  WebAutoSuiteTable,
  WebAutoCaseTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type DeleteTestCaseResult,
  type TesterToolContext,
} from "../types";

export const deleteTestCaseSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP/Workflow), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  caseId: z
    .number()
    .int()
    .positive()
    .describe("The integer ID of the test case to delete."),
});

export function buildDeleteTestCaseTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "delete_test_case",
    description: [
      "Permanently delete an obsolete or invalid test case from the database.",
      "Cascades and removes any associated historical case execution results.",
      "Use this tool to prune outdated test cases or clean up duplicate tests.",
    ].join(" "),
    parameters: deleteTestCaseSchema,
    execute: async ({ category, caseId }): Promise<DeleteTestCaseResult> => {
      if (category === "verification") {
        const [existing] = await db
          .select({
            caseRow: VerificationCaseTable,
            suite: VerificationSuiteTable,
          })
          .from(VerificationCaseTable)
          .innerJoin(
            VerificationSuiteTable,
            eq(VerificationCaseTable.suiteId, VerificationSuiteTable.id),
          )
          .where(
            and(
              eq(VerificationCaseTable.id, caseId),
              ctx.isAdmin
                ? undefined
                : or(
                    eq(VerificationSuiteTable.visibility, "public"),
                    eq(VerificationSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .limit(1);

        if (!existing) {
          throw new Error(`Verification case #${caseId} not found or access denied.`);
        }

        await db
          .delete(VerificationCaseTable)
          .where(eq(VerificationCaseTable.id, caseId));

        return {
          category,
          deleted: true,
          caseId,
          suiteId: existing.caseRow.suiteId,
          caseName: existing.caseRow.name,
        };
      }

      if (category === "evaluation") {
        const [existing] = await db
          .select({
            caseRow: EvalCaseTable,
            suite: EvalSuiteTable,
          })
          .from(EvalCaseTable)
          .innerJoin(
            EvalSuiteTable,
            eq(EvalCaseTable.suiteId, EvalSuiteTable.id),
          )
          .where(
            and(
              eq(EvalCaseTable.id, caseId),
              ctx.isAdmin
                ? undefined
                : or(
                    eq(EvalSuiteTable.visibility, "public"),
                    eq(EvalSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .limit(1);

        if (!existing) {
          throw new Error(`Evaluation case #${caseId} not found or access denied.`);
        }

        await db
          .delete(EvalCaseTable)
          .where(eq(EvalCaseTable.id, caseId));

        return {
          category,
          deleted: true,
          caseId,
          suiteId: existing.caseRow.suiteId,
          caseName: existing.caseRow.name,
        };
      }

      if (category === "web-auto") {
        const [existing] = await db
          .select({
            caseRow: WebAutoCaseTable,
            suite: WebAutoSuiteTable,
          })
          .from(WebAutoCaseTable)
          .innerJoin(
            WebAutoSuiteTable,
            eq(WebAutoCaseTable.suiteId, WebAutoSuiteTable.id),
          )
          .where(
            and(
              eq(WebAutoCaseTable.id, caseId),
              ctx.isAdmin
                ? undefined
                : or(
                    eq(WebAutoSuiteTable.visibility, "public"),
                    eq(WebAutoSuiteTable.createdBy, ctx.userId),
                  ),
            ),
          )
          .limit(1);

        if (!existing) {
          throw new Error(`Web Auto case #${caseId} not found or access denied.`);
        }

        await db
          .delete(WebAutoCaseTable)
          .where(eq(WebAutoCaseTable.id, caseId));

        return {
          category,
          deleted: true,
          caseId,
          suiteId: existing.caseRow.suiteId,
          caseName: existing.caseRow.name,
        };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
