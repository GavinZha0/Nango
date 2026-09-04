import "server-only";

import { z } from "zod";
import { and, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  EvalSuiteTable,
  WebAutoSuiteTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type RunTestSuiteResult,
  type TesterToolContext,
} from "../types";
import { startSuiteRun } from "@/lib/verification/run-orchestrator";
import { startEvalSuiteRun } from "@/lib/evaluation/run-orchestrator";
import { startWebAutoSuiteRun } from "@/lib/web-auto/orchestrator";

export const runTestSuiteSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  suiteId: z
    .string()
    .uuid()
    .describe("The unique UUID of the test suite to execute."),
});

export function buildRunTestSuiteTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "run_test_suite",
    description: [
      "Asynchronously trigger execution of all enabled test cases in a test suite.",
      "Dispatches an asynchronous suite regression run and immediately returns the runId.",
      "The returned runId can then be queried with get_test_results to inspect final outcomes.",
    ].join(" "),
    parameters: runTestSuiteSchema,
    execute: async ({ category, suiteId }): Promise<RunTestSuiteResult> => {
      if (category === "verification") {
        const [suite] = await db
          .select({
            id: VerificationSuiteTable.id,
            name: VerificationSuiteTable.name,
            visibility: VerificationSuiteTable.visibility,
            createdBy: VerificationSuiteTable.createdBy,
          })
          .from(VerificationSuiteTable)
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

        if (!suite) {
          throw new Error(`Verification suite '${suiteId}' not found or access denied.`);
        }

        const runResult = await startSuiteRun({
          suiteId,
          ownerId: ctx.userId,
          triggeredBy: "manual",
        });

        return {
          category,
          suiteId,
          suiteName: suite.name,
          runId: runResult.runId,
          status: "running",
          totalCases: runResult.totalCount,
          message: `Verification suite '${suite.name}' run started. Use get_test_results with runId='${runResult.runId}' to track results.`,
        };
      }

      if (category === "evaluation") {
        const [suite] = await db
          .select({
            id: EvalSuiteTable.id,
            name: EvalSuiteTable.name,
            visibility: EvalSuiteTable.visibility,
            createdBy: EvalSuiteTable.createdBy,
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

        if (!suite) {
          throw new Error(`Evaluation suite '${suiteId}' not found or access denied.`);
        }

        const runResult = await startEvalSuiteRun({
          suiteId,
          ownerId: ctx.userId,
          triggeredBy: "manual",
        });

        return {
          category,
          suiteId,
          suiteName: suite.name,
          runId: runResult.runId,
          status: "running",
          totalCases: runResult.totalCount,
          message: `Evaluation suite '${suite.name}' run started. Use get_test_results with runId='${runResult.runId}' to track results.`,
        };
      }

      if (category === "web-auto") {
        const [suite] = await db
          .select({
            id: WebAutoSuiteTable.id,
            name: WebAutoSuiteTable.name,
            visibility: WebAutoSuiteTable.visibility,
            createdBy: WebAutoSuiteTable.createdBy,
            mcpServerId: WebAutoSuiteTable.mcpServerId,
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

        if (!suite) {
          throw new Error(`Web Auto suite '${suiteId}' not found or access denied.`);
        }

        if (!suite.mcpServerId) {
          throw new Error(`Web Auto suite '${suite.id}' has no Playwright MCP server configured.`);
        }

        const runResult = await startWebAutoSuiteRun({
          suiteId,
          ownerId: ctx.userId,
        });

        return {
          category,
          suiteId,
          suiteName: suite.name,
          runId: runResult.runId,
          status: "running",
          totalCases: runResult.totalCount,
          message: `Web Auto suite '${suite.name}' run started. Use get_test_results with runId='${runResult.runId}' to track results.`,
        };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
