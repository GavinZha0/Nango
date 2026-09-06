import "server-only";

import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type DeleteTestCaseResult,
  type TesterToolContext,
} from "../types";
import { CASE_CATEGORY_CONFIG } from "../category-config";

export const deleteTestCaseSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
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
      const config = CASE_CATEGORY_CONFIG[category];

      const [existing] = await db
        .select({
          caseRow: config.caseTable,
          suite: config.suiteTable,
        })
        .from(config.caseTable)
        .innerJoin(
          config.suiteTable,
          eq(config.caseTable.suiteId, config.suiteTable.id),
        )
        .where(eq(config.caseTable.id, caseId))
        .limit(1);

      if (!existing) {
        throw new Error(`${config.label} case #${caseId} not found.`);
      }

      // Visibility pre-gate, mirroring the REST routes (opaque not-found for
      // suites the caller cannot see).
      const isVisible =
        ctx.isAdmin ||
        existing.suite.visibility === "public" ||
        existing.suite.createdBy === ctx.userId;
      if (!isVisible) {
        throw new Error(`${config.label} case #${caseId} not found.`);
      }

      // CONTRACT (unified delete rule across all three test modules, REST
      // and tool): case author OR suite author OR admin. The tool previously
      // only checked the suite row, which locked case authors out of
      // deleting their own cases inside someone else's shared suite.
      const isAdminUser = ctx.isAdmin;
      const isCaseAuthor = existing.caseRow.createdBy === ctx.userId;
      const isSuiteAuthor = existing.suite.createdBy === ctx.userId;
      if (!isAdminUser && !isCaseAuthor && !isSuiteAuthor) {
        throw new Error(
          "Permission denied: Only the case author, the suite author, or an admin can delete cases.",
        );
      }

      await db
        .delete(config.caseTable)
        .where(eq(config.caseTable.id, caseId));

      return {
        category,
        deleted: true,
        caseId,
        suiteId: existing.caseRow.suiteId,
        caseName: existing.caseRow.name,
      };
    },
  });
}
