import "server-only";

import { z } from "zod";
import { and, desc, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  VerificationRunTable,
  VerificationCaseResultTable,
  VerificationCaseTable,
  EvalSuiteTable,
  EvalRunTable,
  EvalCaseResultTable,
  EvalCaseTable,
  WebAutoSuiteTable,
  WebAutoRunTable,
  WebAutoCaseResultTable,
  WebAutoCaseTable,
} from "@/lib/db/schema";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type CaseAssertionResultItem,
  type CaseResultDiagnosticItem,
  type GetTestResultsResult,
  type RunSummaryItem,
  type TestRunResultItem,
  type TesterToolContext,
} from "../types";
import type { AssertionResult } from "@/lib/assertions";

export const getTestResultsSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP/Workflow), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  runId: z
    .string()
    .uuid()
    .optional()
    .describe("Specific run ID to retrieve. If provided, returns exact run and detailed case results."),
  suiteId: z
    .string()
    .uuid()
    .optional()
    .describe("The test suite ID. Required if runId is not specified."),
  last: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(1)
    .optional()
    .describe("Number of recent runs to retrieve for trend analysis or comparison (1 to 10). Defaults to 1."),
  failedOnly: z
    .boolean()
    .default(false)
    .optional()
    .describe("If true, filters case-level results to only include failed or errored cases for rapid root-cause triage."),
});

function formatAssertionResultItem(
  r: AssertionResult,
): CaseAssertionResultItem {
  let description = r.type;
  if (r.path) {
    description = `${r.path} == ${JSON.stringify(r.expected)}`;
  } else if (r.message) {
    description = r.message
      .replace(/^JS Expression:\s*/i, "")
      .replace(/^Metric:\s*/i, "");
  }

  return {
    type: r.type,
    description,
    passed: Boolean(r.ok),
    message: r.message ?? r.reason ?? r.feedback ?? null,
  };
}

export function buildGetTestResultsTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "get_test_results",
    description: [
      "Retrieve historical or latest test execution results for diagnosis, regression comparison, and reporting.",
      "Dual mode: specify runId to inspect a single run with case-level assertion details, or specify suiteId + last=n to retrieve trend summaries.",
      "Use failedOnly=true to focus specifically on failing cases for root-cause analysis.",
    ].join(" "),
    parameters: getTestResultsSchema,
    execute: async ({
      category,
      runId,
      suiteId,
      last = 1,
      failedOnly = false,
    }): Promise<GetTestResultsResult> => {
      if (!runId && !suiteId) {
        throw new Error("Either 'runId' or 'suiteId' must be specified.");
      }

      if (category === "verification") {
        let targetSuiteId = suiteId;
        let suiteName = "";

        // If runId is provided, find its parent suite first
        if (runId) {
          const [runRow] = await db
            .select({
              run: VerificationRunTable,
              suite: VerificationSuiteTable,
            })
            .from(VerificationRunTable)
            .innerJoin(
              VerificationSuiteTable,
              eq(VerificationRunTable.suiteId, VerificationSuiteTable.id),
            )
            .where(
              and(
                eq(VerificationRunTable.id, runId),
                ctx.isAdmin
                  ? undefined
                  : or(
                      eq(VerificationSuiteTable.visibility, "public"),
                      eq(VerificationSuiteTable.createdBy, ctx.userId),
                    ),
              ),
            )
            .limit(1);

          if (!runRow) {
            throw new Error(`Verification run '${runId}' not found or access denied.`);
          }
          targetSuiteId = runRow.suite.id;
          suiteName = runRow.suite.name;
        } else if (targetSuiteId) {
          const [suiteRow] = await db
            .select({ id: VerificationSuiteTable.id, name: VerificationSuiteTable.name })
            .from(VerificationSuiteTable)
            .where(
              and(
                eq(VerificationSuiteTable.id, targetSuiteId),
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
            throw new Error(`Verification suite '${targetSuiteId}' not found or access denied.`);
          }
          suiteName = suiteRow.name;
        }

        // Fetch runs
        const runRows = await db
          .select()
          .from(VerificationRunTable)
          .where(
            runId
              ? eq(VerificationRunTable.id, runId)
              : eq(VerificationRunTable.suiteId, targetSuiteId!),
          )
          .orderBy(desc(VerificationRunTable.startedAt))
          .limit(runId ? 1 : last);

        const runs: TestRunResultItem[] = [];

        for (const run of runRows) {
          const total = run.totalCount;
          const passed = run.passedCount;
          const failed = run.failedCount;
          const errored = run.erroredCount;
          const passRate = total > 0 ? Number((passed / total).toFixed(3)) : 0;

          const summary: RunSummaryItem = {
            total,
            passed,
            failed,
            errored,
            passRate,
          };

          // Fetch case results if inspecting single run or last === 1
          let cases: CaseResultDiagnosticItem[] | undefined = undefined;
          if (runId || runRows.length === 1) {
            const caseResults = await db
              .select({
                result: VerificationCaseResultTable,
                caseName: VerificationCaseTable.name,
              })
              .from(VerificationCaseResultTable)
              .innerJoin(
                VerificationCaseTable,
                eq(VerificationCaseResultTable.caseId, VerificationCaseTable.id),
              )
              .where(eq(VerificationCaseResultTable.runId, run.id))
              .limit(1000);

            cases = caseResults
              .filter((cr) => (!failedOnly ? true : cr.result.status !== "passed"))
              .map((cr) => {
                const rawAssertions = Array.isArray(cr.result.assertionResults)
                  ? (cr.result.assertionResults as AssertionResult[])
                  : [];
                const rawError = cr.result.error as { message?: string } | null;

                return {
                  caseId: cr.result.caseId,
                  caseName: cr.caseName,
                  status: cr.result.status,
                  durationMs: cr.result.durationMs,
                  error: rawError?.message ?? null,
                  assertionResults: rawAssertions.map(formatAssertionResultItem),
                };
              });
          }

          runs.push({
            runId: run.id,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            summary,
            cases,
          });
        }

        return {
          category,
          suiteId: targetSuiteId!,
          suiteName,
          runs,
        };
      }

      if (category === "evaluation") {
        let targetSuiteId = suiteId;
        let suiteName = "";

        if (runId) {
          const [runRow] = await db
            .select({
              run: EvalRunTable,
              suite: EvalSuiteTable,
            })
            .from(EvalRunTable)
            .innerJoin(
              EvalSuiteTable,
              eq(EvalRunTable.suiteId, EvalSuiteTable.id),
            )
            .where(
              and(
                eq(EvalRunTable.id, runId),
                ctx.isAdmin
                  ? undefined
                  : or(
                      eq(EvalSuiteTable.visibility, "public"),
                      eq(EvalSuiteTable.createdBy, ctx.userId),
                    ),
              ),
            )
            .limit(1);

          if (!runRow) {
            throw new Error(`Evaluation run '${runId}' not found or access denied.`);
          }
          targetSuiteId = runRow.suite.id;
          suiteName = runRow.suite.name;
        } else if (targetSuiteId) {
          const [suiteRow] = await db
            .select({ id: EvalSuiteTable.id, name: EvalSuiteTable.name })
            .from(EvalSuiteTable)
            .where(
              and(
                eq(EvalSuiteTable.id, targetSuiteId),
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
            throw new Error(`Evaluation suite '${targetSuiteId}' not found or access denied.`);
          }
          suiteName = suiteRow.name;
        }

        const runRows = await db
          .select()
          .from(EvalRunTable)
          .where(
            runId
              ? eq(EvalRunTable.id, runId)
              : eq(EvalRunTable.suiteId, targetSuiteId!),
          )
          .orderBy(desc(EvalRunTable.startedAt))
          .limit(runId ? 1 : last);

        const runs: TestRunResultItem[] = [];

        for (const run of runRows) {
          const total = run.totalCount;
          const passed = run.passedCount;
          const failed = run.failedCount;
          const errored = run.erroredCount;
          const passRate = total > 0 ? Number((passed / total).toFixed(3)) : 0;

          const summary: RunSummaryItem = {
            total,
            passed,
            failed,
            errored,
            passRate,
            averageScore: run.score ?? null,
          };

          let cases: CaseResultDiagnosticItem[] | undefined = undefined;
          if (runId || runRows.length === 1) {
            const caseResults = await db
              .select({
                result: EvalCaseResultTable,
                caseName: EvalCaseTable.name,
              })
              .from(EvalCaseResultTable)
              .innerJoin(
                EvalCaseTable,
                eq(EvalCaseResultTable.caseId, EvalCaseTable.id),
              )
              .where(eq(EvalCaseResultTable.runId, run.id))
              .limit(1000);

            cases = caseResults
              .filter((cr) => (!failedOnly ? true : cr.result.status !== "passed"))
              .map((cr) => {
                const rawAssertions = Array.isArray(cr.result.assertionResults)
                  ? (cr.result.assertionResults as AssertionResult[])
                  : [];
                const rawError = cr.result.error as { message?: string } | null;

                return {
                  caseId: cr.result.caseId,
                  caseName: cr.caseName,
                  status: cr.result.status,
                  score: cr.result.score,
                  feedback: cr.result.feedback,
                  error: rawError?.message ?? null,
                  assertionResults: rawAssertions.map(formatAssertionResultItem),
                };
              });
          }

          runs.push({
            runId: run.id,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            summary,
            cases,
          });
        }

        return {
          category,
          suiteId: targetSuiteId!,
          suiteName,
          runs,
        };
      }

      if (category === "web-auto") {
        let targetSuiteId = suiteId;
        let suiteName = "";

        if (runId) {
          const [runRow] = await db
            .select({
              run: WebAutoRunTable,
              suite: WebAutoSuiteTable,
            })
            .from(WebAutoRunTable)
            .innerJoin(
              WebAutoSuiteTable,
              eq(WebAutoRunTable.suiteId, WebAutoSuiteTable.id),
            )
            .where(
              and(
                eq(WebAutoRunTable.id, runId),
                ctx.isAdmin
                  ? undefined
                  : or(
                      eq(WebAutoSuiteTable.visibility, "public"),
                      eq(WebAutoSuiteTable.createdBy, ctx.userId),
                    ),
              ),
            )
            .limit(1);

          if (!runRow) {
            throw new Error(`Web Auto run '${runId}' not found or access denied.`);
          }
          targetSuiteId = runRow.suite.id;
          suiteName = runRow.suite.name;
        } else if (targetSuiteId) {
          const [suiteRow] = await db
            .select({ id: WebAutoSuiteTable.id, name: WebAutoSuiteTable.name })
            .from(WebAutoSuiteTable)
            .where(
              and(
                eq(WebAutoSuiteTable.id, targetSuiteId),
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
            throw new Error(`Web Auto suite '${targetSuiteId}' not found or access denied.`);
          }
          suiteName = suiteRow.name;
        }

        const runRows = await db
          .select()
          .from(WebAutoRunTable)
          .where(
            runId
              ? eq(WebAutoRunTable.id, runId)
              : eq(WebAutoRunTable.suiteId, targetSuiteId!),
          )
          .orderBy(desc(WebAutoRunTable.startedAt))
          .limit(runId ? 1 : last);

        const runs: TestRunResultItem[] = [];

        for (const run of runRows) {
          const passed = run.passed;
          const failed = run.failed;
          const errored = run.errored;
          const total = passed + failed + errored;
          const passRate = total > 0 ? Number((passed / total).toFixed(3)) : 0;

          const summary: RunSummaryItem = {
            total,
            passed,
            failed,
            errored,
            passRate,
          };

          let cases: CaseResultDiagnosticItem[] | undefined = undefined;
          if (runId || runRows.length === 1) {
            const caseResults = await db
              .select({
                result: WebAutoCaseResultTable,
                caseName: WebAutoCaseTable.name,
              })
              .from(WebAutoCaseResultTable)
              .innerJoin(
                WebAutoCaseTable,
                eq(WebAutoCaseResultTable.caseId, WebAutoCaseTable.id),
              )
              .where(eq(WebAutoCaseResultTable.runId, run.id))
              .limit(1000);

            cases = caseResults
              .filter((cr) => (!failedOnly ? true : cr.result.status !== "passed"))
              .map((cr) => {
                const rawAssertions = Array.isArray(cr.result.assertionResults)
                  ? (cr.result.assertionResults as AssertionResult[])
                  : [];
                const rawError = cr.result.error as { message?: string } | null;

                return {
                  caseId: cr.result.caseId,
                  caseName: cr.caseName,
                  status: cr.result.status,
                  durationMs: cr.result.durationMs,
                  score: cr.result.score,
                  feedback: cr.result.feedback,
                  error: rawError?.message ?? null,
                  assertionResults: rawAssertions.map(formatAssertionResultItem),
                };
              });
          }

          runs.push({
            runId: run.id,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            summary,
            cases,
          });
        }

        return {
          category,
          suiteId: targetSuiteId!,
          suiteName,
          runs,
        };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
