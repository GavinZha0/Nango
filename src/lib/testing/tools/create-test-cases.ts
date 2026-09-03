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
import { canEditResource } from "@/lib/auth/permissions";
import { isUniqueViolation } from "@/lib/http/validation";
import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";
import {
  testCategorySchema,
  type CreatedCaseItem,
  type CreateTestCasesResult,
  type TesterToolContext,
} from "../types";
import { normalizeAndValidateAssertions } from "../assertion-validation";

export const createCaseItemSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Descriptive name of the test case."),

  // Verification specific
  toolName: z
    .string()
    .trim()
    .optional()
    .describe("Target tool name from the suite's MCP server (required for verification)."),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Tool argument input payload (e.g. { query: 'Azure' })."),

  // Evaluation specific: simple plain text prompt strings for multi-turn user prompts
  turns: z
    .array(z.string().min(1))
    .optional()
    .describe("List of user prompt texts representing multi-turn conversational inputs (required for evaluation)."),

  // Web Auto specific
  script: z
    .string()
    .optional()
    .describe("Playwright automation script (Node.js/JS)."),
  steps: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Visual recorder actions list."),

  // Universal assertions list
  assertions: z
    .array(z.record(z.string(), z.unknown()))
    .default([])
    .describe(
      "Assertion specifications list. Supported types: 'js_expression', 'jsonpath', 'json_schema', 'metric', 'tool_call', 'llm_judge'.",
    ),
});

export const createTestCasesSchema = z.object({
  category: testCategorySchema.describe(
    "Required test category: 'verification' (MCP), 'evaluation' (Agent benchmark), or 'web-auto' (Playwright UI).",
  ),
  suiteId: z
    .string()
    .uuid()
    .describe("The target suite ID where test cases will be created."),
  cases: z
    .array(createCaseItemSchema)
    .min(1)
    .max(20)
    .describe("Array of test cases to create in batch (1 to 20 items)."),
});

function findConflictingCaseNames(cases: Array<{ name: string }>, existingNames: string[]): string[] {
  const existingSet = new Set(existingNames);
  const conflicts: string[] = [];

  for (const c of cases) {
    if (existingSet.has(c.name)) {
      conflicts.push(`'${c.name}'`);
    }
  }

  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) {
      conflicts.push(`'${c.name}' (duplicate in batch)`);
    } else {
      seen.add(c.name);
    }
  }

  return Array.from(new Set(conflicts));
}

export function buildCreateTestCasesTool(ctx: TesterToolContext): ToolDefinition {
  return defineTool({
    name: "create_test_cases",
    description: [
      "Create one or multiple test cases in batch under a target test suite.",
      "Newly created test cases are always initialized with enabled: false for safety (must be reviewed before activation).",
      "Supports 'verification' (toolName + input), 'evaluation' (turns of user prompts), and 'web-auto' (script + steps).",
    ].join(" "),
    parameters: createTestCasesSchema,
    execute: async ({ category, suiteId, cases }): Promise<CreateTestCasesResult> => {
      if (category === "verification") {
        const [suiteRow] = await db
          .select({
            id: VerificationSuiteTable.id,
            mcpServerId: VerificationSuiteTable.mcpServerId,
            visibility: VerificationSuiteTable.visibility,
            createdBy: VerificationSuiteTable.createdBy,
          })
          .from(VerificationSuiteTable)
          .where(eq(VerificationSuiteTable.id, suiteId))
          .limit(1);

        if (!suiteRow) {
          throw new Error(`Verification suite '${suiteId}' not found.`);
        }

        const suiteRBAC = {
          visibility: suiteRow.visibility as "private" | "public",
          createdBy: suiteRow.createdBy,
        };

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You cannot create cases in this suite.`);
        }

        let inserted: Array<{ id: number; name: string; toolName: string | null; assertions: unknown }>;
        try {
          inserted = await db.transaction(async (tx) => {
            return tx
              .insert(VerificationCaseTable)
              .values(
                cases.map((c) => ({
                  suiteId,
                  name: c.name,
                  toolName: c.toolName ?? null,
                  input: c.input ?? {},
                  assertions: normalizeAndValidateAssertions(c.assertions ?? [], c.name),
                  enabled: false, // Contract: always false
                  createdBy: ctx.userId,
                })),
              )
              .returning({
                id: VerificationCaseTable.id,
                name: VerificationCaseTable.name,
                toolName: VerificationCaseTable.toolName,
                assertions: VerificationCaseTable.assertions,
              });
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            const existing = await db
              .select({ name: VerificationCaseTable.name })
              .from(VerificationCaseTable)
              .where(eq(VerificationCaseTable.suiteId, suiteId));
            const conflicts = findConflictingCaseNames(cases, existing.map((r) => r.name));
            const conflictMsg = conflicts.length > 0 ? conflicts.join(", ") : "one or more cases";
            throw new Error(
              `Failed to create test cases: duplicate case name(s) [${conflictMsg}] already exist in suite '${suiteId}'. Please modify the conflicting case names to be unique.`,
            );
          }
          throw err;
        }

        const createdCases: CreatedCaseItem[] = inserted.map((row) => ({
          id: row.id,
          name: row.name,
          toolName: row.toolName ?? null,
          enabled: false,
          assertionCount: Array.isArray(row.assertions) ? row.assertions.length : 0,
        }));

        return {
          category,
          suiteId,
          createdCount: createdCases.length,
          cases: createdCases,
        };
      }

      if (category === "evaluation") {
        const [suiteRow] = await db
          .select({
            id: EvalSuiteTable.id,
            visibility: EvalSuiteTable.visibility,
            createdBy: EvalSuiteTable.createdBy,
          })
          .from(EvalSuiteTable)
          .where(eq(EvalSuiteTable.id, suiteId))
          .limit(1);

        if (!suiteRow) {
          throw new Error(`Evaluation suite '${suiteId}' not found.`);
        }

        const suiteRBAC = {
          visibility: suiteRow.visibility as "private" | "public",
          createdBy: suiteRow.createdBy,
        };

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You cannot create cases in this suite.`);
        }

        let inserted: Array<{ id: number; name: string; assertions: unknown }>;
        try {
          inserted = await db.transaction(async (tx) => {
            return tx
              .insert(EvalCaseTable)
              .values(
                cases.map((c) => {
                  const formattedTurns = (c.turns ?? []).map((userText) => ({
                    userMessage: userText,
                  }));
                  return {
                    suiteId,
                    name: c.name,
                    input: { turns: formattedTurns },
                    assertions: normalizeAndValidateAssertions(c.assertions ?? [], c.name),
                    enabled: false, // Contract: always false
                    createdBy: ctx.userId,
                  };
                }),
              )
              .returning({
                id: EvalCaseTable.id,
                name: EvalCaseTable.name,
                assertions: EvalCaseTable.assertions,
              });
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            const existing = await db
              .select({ name: EvalCaseTable.name })
              .from(EvalCaseTable)
              .where(eq(EvalCaseTable.suiteId, suiteId));
            const conflicts = findConflictingCaseNames(cases, existing.map((r) => r.name));
            const conflictMsg = conflicts.length > 0 ? conflicts.join(", ") : "one or more cases";
            throw new Error(
              `Failed to create test cases: duplicate case name(s) [${conflictMsg}] already exist in suite '${suiteId}'. Please modify the conflicting case names to be unique.`,
            );
          }
          throw err;
        }

        const createdCases: CreatedCaseItem[] = inserted.map((row) => ({
          id: row.id,
          name: row.name,
          enabled: false,
          assertionCount: Array.isArray(row.assertions) ? row.assertions.length : 0,
        }));

        return {
          category,
          suiteId,
          createdCount: createdCases.length,
          cases: createdCases,
        };
      }

      if (category === "web-auto") {
        const [suiteRow] = await db
          .select({
            id: WebAutoSuiteTable.id,
            visibility: WebAutoSuiteTable.visibility,
            createdBy: WebAutoSuiteTable.createdBy,
          })
          .from(WebAutoSuiteTable)
          .where(eq(WebAutoSuiteTable.id, suiteId))
          .limit(1);

        if (!suiteRow) {
          throw new Error(`Web Auto suite '${suiteId}' not found.`);
        }

        const suiteRBAC = {
          visibility: suiteRow.visibility as "private" | "public",
          createdBy: suiteRow.createdBy,
        };

        if (!canEditResource(suiteRBAC, ctx)) {
          throw new Error(`Permission denied: You cannot create cases in this suite.`);
        }

        const inserted = await db.transaction(async (tx) => {
          return tx
            .insert(WebAutoCaseTable)
            .values(
              cases.map((c) => ({
                suiteId,
                name: c.name,
                input: {
                  script: c.script ?? "",
                  steps: c.steps ?? [],
                },
                assertions: normalizeAndValidateAssertions(c.assertions ?? [], c.name),
                enabled: false, // Contract: always false
                createdBy: ctx.userId,
              })),
            )
            .returning({
              id: WebAutoCaseTable.id,
              name: WebAutoCaseTable.name,
              assertions: WebAutoCaseTable.assertions,
            });
        });

        const createdCases: CreatedCaseItem[] = inserted.map((row) => ({
          id: row.id,
          name: row.name,
          enabled: false,
          assertionCount: Array.isArray(row.assertions) ? row.assertions.length : 0,
        }));

        return {
          category,
          suiteId,
          createdCount: createdCases.length,
          cases: createdCases,
        };
      }

      throw new Error(`Unsupported category: ${category}`);
    },
  });
}
