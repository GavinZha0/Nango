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
  type CaseDetailsItem,
  type TesterToolContext,
  type TestCaseDetailsResult,
} from "../types";

export const getTestCaseDetailsSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  caseId: z
    .number()
    .int()
    .positive()
    .describe("The integer ID of the test case to inspect."),
});

export function buildGetTestCaseDetailsTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "get_test_case_details",
    description: [
      "Get full configuration, inputs, and assertion specifications for a single test case.",
      "Returns the case name, input payload, conversational turns or Playwright script, and full list of assertions.",
      "Use this tool to deeply inspect a specific test case before running diagnostics or proposing modifications.",
    ].join(" "),
    parameters: getTestCaseDetailsSchema,
    execute: async ({ category, caseId }): Promise<TestCaseDetailsResult> => {
      if (category === "verification") {
        const [row] = await db
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

        if (!row) {
          throw new Error(`Verification case #${caseId} not found or access denied.`);
        }

        const caseDetails: CaseDetailsItem = {
          id: row.caseRow.id,
          suiteId: row.caseRow.suiteId,
          name: row.caseRow.name,
          toolName: row.caseRow.toolName ?? null,
          enabled: Boolean(row.caseRow.enabled),
          input: row.caseRow.input ?? {},
          assertions: Array.isArray(row.caseRow.assertions) ? row.caseRow.assertions : [],
        };

        return { category, case: caseDetails };
      }

      if (category === "evaluation") {
        const [row] = await db
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

        if (!row) {
          throw new Error(`Evaluation case #${caseId} not found or access denied.`);
        }

        const caseInput = (row.caseRow.input ?? {}) as Record<string, unknown>;
        const turns = Array.isArray(caseInput.turns) ? caseInput.turns : [];

        const caseDetails: CaseDetailsItem = {
          id: row.caseRow.id,
          suiteId: row.caseRow.suiteId,
          name: row.caseRow.name,
          enabled: Boolean(row.caseRow.enabled),
          turns,
          assertions: Array.isArray(row.caseRow.assertions) ? row.caseRow.assertions : [],
        };

        return { category, case: caseDetails };
      }

      if (category === "web-auto") {
        const [row] = await db
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

        if (!row) {
          throw new Error(`Web Auto case #${caseId} not found or access denied.`);
        }

        const caseInput = (row.caseRow.input ?? {}) as Record<string, unknown>;

        const caseDetails: CaseDetailsItem = {
          id: row.caseRow.id,
          suiteId: row.caseRow.suiteId,
          name: row.caseRow.name,
          enabled: Boolean(row.caseRow.enabled),
          script: typeof caseInput.script === "string" ? caseInput.script : null,
          steps: Array.isArray(caseInput.steps) ? caseInput.steps : null,
          assertions: Array.isArray(row.caseRow.assertions) ? row.caseRow.assertions : [],
        };

        return { category, case: caseDetails };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
