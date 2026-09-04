import "server-only";

import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationSuiteTable,
  VerificationCaseTable,
  EvalSuiteTable,
  EvalCaseTable,
  WebAutoSuiteTable,
  WebAutoCaseTable,
} from "@/lib/db/schema";
import { canEditResource } from "@/lib/auth/permissions";
import { isUniqueViolation } from "@/lib/http/validation";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  type CaseDetailsItem,
  type TesterToolContext,
  type UpdateTestCaseResult,
} from "../types";
import { normalizeAndValidateAssertions, WARNING_EVALUATOR_MISSING, containsJudgeDependentAssertions } from "../assertion-validation";

const updateCommonFields = {
  caseId: z
    .number()
    .int()
    .positive()
    .describe("The integer ID of the test case to update."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional new descriptive name for the test case."),
  enabled: z
    .boolean()
    .optional()
    .describe("Optional toggle to enable or disable the case (e.g. true to activate after review)."),
  assertions: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      "Optional updated list of assertion specifications (replaces existing assertions). Supported types are category-scoped — inspect with get_assertion_schema.",
    ),
};

export const updateTestCaseSchema = z.discriminatedUnion("category", [
  z.object({
    category: z.literal("verification"),
    ...updateCommonFields,
    toolName: z.string().trim().optional().describe("Optional updated tool name."),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional updated tool arguments payload."),
  }).strict(),
  z.object({
    category: z.literal("evaluation"),
    ...updateCommonFields,
    turns: z
      .array(z.string().min(1))
      .optional()
      .describe("Optional updated multi-turn user prompt texts."),
  }).strict(),
  z.object({
    category: z.literal("web-auto"),
    ...updateCommonFields,
    script: z
      .string()
      .optional()
      .describe("Optional updated Playwright script."),
    steps: z
      .string()
      .optional()
      .describe("Optional updated natural language test steps (non-executable documentation)."),
  }).strict(),
]);

/** Throw a friendly duplicate-name error on a unique violation during an update.
 *  Shared by all three categories so a branch can't drop conflict handling. */
function throwUpdateCaseNameConflict(
  err: unknown,
  category: string,
  caseId: number,
  name: unknown,
): never {
  if (!isUniqueViolation(err)) throw err;
  const nameStr = typeof name === "string" ? name : "";
  throw new Error(
    `Failed to update ${category} case #${caseId}: a test case named '${nameStr}' already exists in this suite.`,
  );
}

export function buildUpdateTestCaseTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "update_test_case",
    description: [
      "Update fields on an existing test case (partial update).",
      "Supports modifying name, enabled status, inputs/turns/scripts, and assertions list.",
      "Use this tool to repair broken assertions, adjust input parameters, or activate cases after review.",
    ].join(" "),
    parameters: updateTestCaseSchema,
    execute: async (params): Promise<UpdateTestCaseResult> => {
      if (params.category === "verification") {
        const { category, caseId, name, enabled, toolName, input, assertions } = params;
        const hasAnyField =
          name !== undefined ||
          enabled !== undefined ||
          toolName !== undefined ||
          input !== undefined ||
          assertions !== undefined;

        if (!hasAnyField) {
          throw new Error("At least one field to update must be provided.");
        }
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

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You do not have permission to edit cases in this suite.`);
        }

        const updates: Record<string, unknown> = {
          updatedAt: sql`CURRENT_TIMESTAMP`,
        };
        if (name !== undefined) updates.name = name;
        if (enabled !== undefined) updates.enabled = enabled;
        if (toolName !== undefined) updates.toolName = toolName;
        if (input !== undefined) updates.input = input;
        if (assertions !== undefined) {
          updates.assertions = normalizeAndValidateAssertions(assertions, existing.caseRow.name);
        }

        let updated: typeof VerificationCaseTable.$inferSelect | undefined;
        try {
          const res = await db
            .update(VerificationCaseTable)
            .set(updates)
            .where(eq(VerificationCaseTable.id, caseId))
            .returning();
          updated = res[0];
        } catch (err) {
          throwUpdateCaseNameConflict(err, "verification", caseId, updates.name);
        }

        if (!updated) {
          throw new Error(`Failed to update verification case #${caseId}.`);
        }

        const caseDetails: CaseDetailsItem = {
          id: updated.id,
          suiteId: updated.suiteId,
          name: updated.name,
          toolName: updated.toolName ?? null,
          enabled: Boolean(updated.enabled),
          input: updated.input ?? {},
          assertions: Array.isArray(updated.assertions) ? updated.assertions : [],
        };

        return { category, updated: true, case: caseDetails };
      }

      if (params.category === "evaluation") {
        const { category, caseId, name, enabled, turns, assertions } = params;
        const hasAnyField =
          name !== undefined || enabled !== undefined || turns !== undefined || assertions !== undefined;

        if (!hasAnyField) {
          throw new Error("At least one field to update must be provided.");
        }
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

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You do not have permission to edit cases in this suite.`);
        }

        const updates: Record<string, unknown> = {
          updatedAt: sql`CURRENT_TIMESTAMP`,
        };
        if (name !== undefined) updates.name = name;
        if (enabled !== undefined) updates.enabled = enabled;
        if (assertions !== undefined) {
          updates.assertions = normalizeAndValidateAssertions(assertions, existing.caseRow.name);
        }
        if (turns !== undefined) {
          updates.input = {
            turns: turns.map((userText) => ({ userMessage: userText })),
          };
        }

        let updated: typeof EvalCaseTable.$inferSelect | undefined;
        try {
          const res = await db
            .update(EvalCaseTable)
            .set(updates)
            .where(eq(EvalCaseTable.id, caseId))
            .returning();
          updated = res[0];
        } catch (err) {
          throwUpdateCaseNameConflict(err, "evaluation", caseId, updates.name);
        }

        if (!updated) {
          throw new Error(`Failed to update evaluation case #${caseId}.`);
        }

        const caseInput = (updated.input ?? {}) as Record<string, unknown>;
        const returnedTurns = Array.isArray(caseInput.turns) ? caseInput.turns : [];

        const caseDetails: CaseDetailsItem = {
          id: updated.id,
          suiteId: updated.suiteId,
          name: updated.name,
          enabled: Boolean(updated.enabled),
          turns: returnedTurns,
          assertions: Array.isArray(updated.assertions) ? updated.assertions : [],
        };

        // Non-blocking config warning: judge-dependent assertions under a suite
        // with no evaluator agent return `errored` when run (never a silent pass).
        const updatedAssertions = Array.isArray(updated.assertions) ? updated.assertions : [];
        const warnings: string[] = [];
        if (
          !existing.suite.evaluatorAgentId &&
          (containsJudgeDependentAssertions(assertions) ||
            containsJudgeDependentAssertions(updatedAssertions))
        ) {
          warnings.push(WARNING_EVALUATOR_MISSING);
        }

        return {
          category,
          updated: true,
          case: caseDetails,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }

      if (params.category === "web-auto") {
        const { category, caseId, name, enabled, script, steps, assertions } = params;
        const hasAnyField =
          name !== undefined || enabled !== undefined || script !== undefined || steps !== undefined || assertions !== undefined;

        if (!hasAnyField) {
          throw new Error("At least one field to update must be provided.");
        }
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

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You do not have permission to edit cases in this suite.`);
        }

        const updates: Record<string, unknown> = {
          updatedAt: sql`CURRENT_TIMESTAMP`,
        };
        if (name !== undefined) updates.name = name;
        if (enabled !== undefined) updates.enabled = enabled;
        if (assertions !== undefined) {
          updates.assertions = normalizeAndValidateAssertions(assertions, existing.caseRow.name);
        }
        if (script !== undefined || steps !== undefined) {
          const existingInput = (existing.caseRow.input ?? {}) as Record<string, unknown>;
          updates.input = {
            script: script !== undefined ? script : (existingInput.script ?? ""),
            steps: steps !== undefined ? steps : (typeof existingInput.steps === "string" ? existingInput.steps : ""),
          };
        }

        let updated: typeof WebAutoCaseTable.$inferSelect | undefined;
        try {
          const res = await db
            .update(WebAutoCaseTable)
            .set(updates)
            .where(eq(WebAutoCaseTable.id, caseId))
            .returning();
          updated = res[0];
        } catch (err) {
          throwUpdateCaseNameConflict(err, "web-auto", caseId, updates.name);
        }

        if (!updated) {
          throw new Error(`Failed to update web-auto case #${caseId}.`);
        }

        const caseInput = (updated.input ?? {}) as Record<string, unknown>;

        const caseDetails: CaseDetailsItem = {
          id: updated.id,
          suiteId: updated.suiteId,
          name: updated.name,
          enabled: Boolean(updated.enabled),
          script: typeof caseInput.script === "string" ? caseInput.script : null,
          steps: typeof caseInput.steps === "string" ? caseInput.steps : null,
          assertions: Array.isArray(updated.assertions) ? updated.assertions : [],
        };

        // Same config warning as the evaluation branch: judge-dependent
        // assertions under a suite with no evaluator agent return `errored`
        // when run (never a silent pass).
        const updatedAssertions = Array.isArray(updated.assertions) ? updated.assertions : [];
        const warnings: string[] = [];
        if (
          !existing.suite.evaluatorAgentId &&
          (containsJudgeDependentAssertions(assertions) ||
            containsJudgeDependentAssertions(updatedAssertions))
        ) {
          warnings.push(WARNING_EVALUATOR_MISSING);
        }

        return {
          category,
          updated: true,
          case: caseDetails,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }

      throw new Error("Unsupported category.");
    },
  });
}
