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
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type CaseDetailsItem,
  type TesterToolContext,
  type UpdateTestCaseResult,
} from "../types";

export const updateTestCaseSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP/Workflow), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
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

  // Verification specific
  toolName: z
    .string()
    .trim()
    .optional()
    .describe("Optional updated tool name."),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional updated tool arguments payload."),

  // Evaluation specific
  turns: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional updated multi-turn user prompt texts."),

  // Web Auto specific
  script: z
    .string()
    .optional()
    .describe("Optional updated Playwright script."),
  steps: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Optional updated recorder steps list."),

  // Universal assertions
  assertions: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Optional updated list of assertion specifications (replaces existing assertions)."),
});

export function buildUpdateTestCaseTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "update_test_case",
    description: [
      "Update fields on an existing test case (partial update).",
      "Supports modifying name, enabled status, inputs/turns/scripts, and assertions list.",
      "Use this tool to repair broken assertions, adjust input parameters, or activate cases after review.",
    ].join(" "),
    parameters: updateTestCaseSchema,
    execute: async ({
      category,
      caseId,
      name,
      enabled,
      toolName,
      input,
      turns,
      script,
      steps,
      assertions,
    }): Promise<UpdateTestCaseResult> => {
      const hasAnyField =
        name !== undefined ||
        enabled !== undefined ||
        toolName !== undefined ||
        input !== undefined ||
        turns !== undefined ||
        script !== undefined ||
        steps !== undefined ||
        assertions !== undefined;

      if (!hasAnyField) {
        throw new Error("At least one field to update must be provided.");
      }

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
        if (assertions !== undefined) updates.assertions = assertions;

        const [updated] = await db
          .update(VerificationCaseTable)
          .set(updates)
          .where(eq(VerificationCaseTable.id, caseId))
          .returning();

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

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You do not have permission to edit cases in this suite.`);
        }

        const updates: Record<string, unknown> = {
          updatedAt: sql`CURRENT_TIMESTAMP`,
        };
        if (name !== undefined) updates.name = name;
        if (enabled !== undefined) updates.enabled = enabled;
        if (assertions !== undefined) updates.assertions = assertions;
        if (turns !== undefined) {
          updates.input = {
            turns: turns.map((userText) => ({ userMessage: userText })),
          };
        }

        const [updated] = await db
          .update(EvalCaseTable)
          .set(updates)
          .where(eq(EvalCaseTable.id, caseId))
          .returning();

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

        return { category, updated: true, case: caseDetails };
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

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You do not have permission to edit cases in this suite.`);
        }

        const updates: Record<string, unknown> = {
          updatedAt: sql`CURRENT_TIMESTAMP`,
        };
        if (name !== undefined) updates.name = name;
        if (enabled !== undefined) updates.enabled = enabled;
        if (assertions !== undefined) updates.assertions = assertions;
        if (script !== undefined || steps !== undefined) {
          const existingInput = (existing.caseRow.input ?? {}) as Record<string, unknown>;
          updates.input = {
            script: script !== undefined ? script : (existingInput.script ?? ""),
            steps: steps !== undefined ? steps : (existingInput.steps ?? []),
          };
        }

        const [updated] = await db
          .update(WebAutoCaseTable)
          .set(updates)
          .where(eq(WebAutoCaseTable.id, caseId))
          .returning();

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
          steps: Array.isArray(caseInput.steps) ? caseInput.steps : null,
          assertions: Array.isArray(updated.assertions) ? updated.assertions : [],
        };

        return { category, updated: true, case: caseDetails };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
