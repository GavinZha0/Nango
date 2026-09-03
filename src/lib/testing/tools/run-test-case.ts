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
  type CaseAssertionResultItem,
  type RunTestCaseResult,
  type TesterToolContext,
} from "../types";
import { runMcpCase } from "@/lib/verification/runner-mcp";
import { runEvalCase } from "@/lib/evaluation/eval-runner";
import { runWebAutoCase } from "@/lib/web-auto/orchestrator";
import type { AssertionSpec } from "@/lib/assertions";

export const runTestCaseSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  caseId: z
    .number()
    .int()
    .positive()
    .describe("The integer ID of the test case to execute."),
});

function formatAssertionResultItem(
  result: import("@/lib/assertions").AssertionResult,
  spec?: AssertionSpec,
): CaseAssertionResultItem {
  let description = result.type;
  if (spec) {
    if (spec.type === "js_expression") description = spec.expression;
    else if (spec.type === "jsonpath")
      description = `${spec.path} ${spec.operator ?? "=="} ${JSON.stringify(spec.expected)}`;
    else if (spec.type === "json_schema") description = "JSON Schema validation";
    else if (spec.type === "metric")
      description = `${spec.metric} ${spec.operator} ${spec.threshold}`;
    else if (spec.type === "tool_call") description = `Tool: ${spec.toolName}`;
    else if ("expectation" in spec && spec.expectation) description = spec.expectation;
  } else if (result.message) {
    description = result.message
      .replace(/^JS Expression:\s*/i, "")
      .replace(/^Metric:\s*/i, "");
  } else if (result.path) {
    description = result.path;
  }

  return {
    type: result.type,
    description,
    passed: Boolean(result.ok),
    message: result.message ?? result.reason ?? result.feedback ?? null,
  };
}

export function buildRunTestCaseTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "run_test_case",
    description: [
      "Synchronously execute a single test case for rapid debugging and validation.",
      "Returns live execution status, duration, and detailed assertion results without waiting for full suite runs.",
      "Supports 'verification', 'evaluation', and 'web-auto'.",
    ].join(" "),
    parameters: runTestCaseSchema,
    execute: async ({ category, caseId }): Promise<RunTestCaseResult> => {
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

        const { caseRow, suite } = existing;

        if (!suite.mcpServerId || !caseRow.toolName) {
          throw new Error(`Verification case #${caseId} is missing mcpServerId or toolName.`);
        }

        const specs = (caseRow.assertions ?? []) as readonly AssertionSpec[];
        const outcome = await runMcpCase({
          mcpServerId: suite.mcpServerId,
          toolName: caseRow.toolName,
          input: (caseRow.input ?? {}) as Record<string, unknown>,
          assertions: specs,
        });

        const assertionResults: CaseAssertionResultItem[] = (
          outcome.assertionResults ?? []
        ).map((r, idx) => formatAssertionResultItem(r, specs[idx]));

        const status =
          outcome.status === "errored"
            ? "errored"
            : outcome.status === "passed"
              ? "passed"
              : "failed";

        return {
          category,
          caseId,
          caseName: caseRow.name,
          status,
          durationMs: outcome.durationMs ?? 0,
          assertionResults,
          error: outcome.error ? outcome.error.message : null,
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

        const { caseRow, suite } = existing;
        const caseInput = (caseRow.input ?? {}) as Record<string, unknown>;
        const rawTurns = Array.isArray(caseInput.turns) ? caseInput.turns : [];
        const turns = rawTurns.map((t) => {
          if (typeof t === "string") return { userMessage: t };
          if (t && typeof t === "object" && "userMessage" in t) {
            return { userMessage: String((t as { userMessage: unknown }).userMessage) };
          }
          return { userMessage: String(t) };
        });

        const specs = (caseRow.assertions ?? []) as readonly AssertionSpec[];
        const outcome = await runEvalCase({
          caseId: caseRow.id,
          targetAgentId: suite.agentId,
          targetCredentialId: suite.credentialId ?? undefined,
          evaluatorAgentId: suite.evaluatorAgentId,
          dimensionIds: (suite.dimensionIds ?? []) as string[],
          turns,
          assertions: specs,
          ownerId: ctx.userId,
        });

        const assertionResults: CaseAssertionResultItem[] = (
          outcome.assertionResults ?? []
        ).map((r, idx) => formatAssertionResultItem(r, specs[idx]));

        const status =
          outcome.status === "errored"
            ? "errored"
            : outcome.status === "passed"
              ? "passed"
              : "failed";

        return {
          category,
          caseId,
          caseName: caseRow.name,
          status,
          durationMs: outcome.durationMs ?? 0,
          assertionResults,
          score: outcome.score ?? null,
          feedback: outcome.feedback ?? null,
          error: outcome.error ?? null,
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

        const { caseRow, suite } = existing;

        if (!suite.mcpServerId) {
          throw new Error(`Web Auto suite '${suite.id}' has no Playwright MCP server configured.`);
        }

        const rawInput = (caseRow.input ?? {}) as Record<string, unknown>;
        if (!rawInput.script || typeof rawInput.script !== "string") {
          throw new Error(`Web Auto case #${caseId} has no script content to execute.`);
        }

        const specs = (caseRow.assertions ?? []) as readonly AssertionSpec[];
        const outcome = await runWebAutoCase({
          caseId: caseRow.id,
          suiteId: suite.id,
          suite,
          case: caseRow,
          ownerId: ctx.userId,
        });

        const assertionResults: CaseAssertionResultItem[] = (
          outcome.assertionResults ?? []
        ).map((r, idx) => formatAssertionResultItem(r, specs[idx]));

        const status =
          outcome.status === "errored"
            ? "errored"
            : outcome.status === "passed"
              ? "passed"
              : "failed";

        return {
          category,
          caseId,
          caseName: caseRow.name,
          status,
          durationMs: outcome.durationMs ?? 0,
          assertionResults,
          error: outcome.error ? outcome.error.message : null,
        };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
