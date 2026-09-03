import "server-only";

import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  VerificationCaseTable,
  EvalSuiteTable,
  EvalCaseTable,
  WebAutoSuiteTable,
  WebAutoCaseTable,
} from "@/lib/db/schema";
import { canDeleteResource } from "@/lib/auth/permissions";
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
          .where(eq(VerificationCaseTable.id, caseId))
          .limit(1);

        if (!existing) {
          throw new Error(`Verification case #${caseId} not found.`);
        }

        const suiteRBAC = {
          visibility: existing.suite.visibility as "private" | "public",
          createdBy: existing.suite.createdBy,
        };

        if (!canDeleteResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: Only the suite author or an admin can delete cases.`);
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
          .where(eq(EvalCaseTable.id, caseId))
          .limit(1);

        if (!existing) {
          throw new Error(`Evaluation case #${caseId} not found.`);
        }

        const suiteRBAC = {
          visibility: existing.suite.visibility as "private" | "public",
          createdBy: existing.suite.createdBy,
        };

        if (!canDeleteResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: Only the suite author or an admin can delete cases.`);
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
          .where(eq(WebAutoCaseTable.id, caseId))
          .limit(1);

        if (!existing) {
          throw new Error(`Web Auto case #${caseId} not found.`);
        }

        const suiteRBAC = {
          visibility: existing.suite.visibility as "private" | "public",
          createdBy: existing.suite.createdBy,
        };

        if (!canDeleteResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: Only the suite author or an admin can delete cases.`);
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
