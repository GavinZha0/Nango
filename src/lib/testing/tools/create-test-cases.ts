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
  type CreatedCaseItem,
  type CreateTestCasesResult,
  type TesterToolContext,
} from "../types";
import { normalizeAndValidateAssertions, WARNING_EVALUATOR_MISSING, containsJudgeDependentAssertions } from "../assertion-validation";
import { CATEGORY_TYPE_MAPPING } from "@/lib/assertions/types";

// Generated from the shared contract so the tool description cannot drift
// from get_assertion_schema's category bindings.
const ASSERTIONS_FIELD_HINT = [
  "Assertion specifications list. Supported types are category-scoped:",
  Object.entries(CATEGORY_TYPE_MAPPING)
    .map(([category, types]) => `'${category}': ${types.join(", ")}`)
    .join("; "),
  "Inspect exact specs with get_assertion_schema.",
].join(" ");

const caseNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Descriptive name of the test case.");
const caseAssertionsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .default([])
  .describe(ASSERTIONS_FIELD_HINT);

const verificationCaseItemSchema = z.object({
  name: caseNameSchema,
  toolName: z
    .string()
    .trim()
    .optional()
    .describe("Target tool name from the suite's MCP server (required for verification)."),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Tool argument input payload (e.g. { query: 'Azure' })."),
  assertions: caseAssertionsSchema,
}).strict();

const evaluationCaseItemSchema = z.object({
  name: caseNameSchema,
  turns: z
    .array(z.string().min(1))
    .optional()
    .describe("List of user prompt texts representing multi-turn conversational inputs (required for evaluation)."),
  assertions: caseAssertionsSchema,
}).strict();

const webAutoCaseItemSchema = z.object({
  name: caseNameSchema,
  script: z
    .string()
    .optional()
    .describe("Playwright automation script (Node.js/JS)."),
  steps: z
    .string()
    .optional()
    .describe("Natural language test steps (non-executable documentation readable by the assistant)."),
  assertions: caseAssertionsSchema,
}).strict();

const suiteIdSchema = z
  .string()
  .uuid()
  .describe("The target suite ID where test cases will be created.");
const casesArrayDescription = "Array of test cases to create in batch (1 to 20 items).";

export const createTestCasesSchema = z.discriminatedUnion("category", [
  z.object({
    category: z.literal("verification"),
    suiteId: suiteIdSchema,
    cases: z.array(verificationCaseItemSchema).min(1).max(20).describe(casesArrayDescription),
  }).strict(),
  z.object({
    category: z.literal("evaluation"),
    suiteId: suiteIdSchema,
    cases: z.array(evaluationCaseItemSchema).min(1).max(20).describe(casesArrayDescription),
  }).strict(),
  z.object({
    category: z.literal("web-auto"),
    suiteId: suiteIdSchema,
    cases: z.array(webAutoCaseItemSchema).min(1).max(20).describe(casesArrayDescription),
  }).strict(),
]);

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

/** Throw a friendly duplicate-name error on a unique violation, looking up the
 *  suite's existing case names to list the conflicts. Shared by all three
 *  categories so a branch can't silently drop conflict handling. */
async function throwCaseNameConflict(
  err: unknown,
  loadExistingNames: () => Promise<Array<{ name: string }>>,
  cases: Array<{ name: string }>,
  suiteId: string,
): Promise<never> {
  if (!isUniqueViolation(err)) throw err;
  const existing = await loadExistingNames();
  const conflicts = findConflictingCaseNames(cases, existing.map((r) => r.name));
  const conflictMsg = conflicts.length > 0 ? conflicts.join(", ") : "one or more cases";
  throw new Error(
    `Failed to create test cases: duplicate case name(s) [${conflictMsg}] already exist in suite '${suiteId}'. Please modify the conflicting case names to be unique.`,
  );
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
    execute: async (params): Promise<CreateTestCasesResult> => {
      if (params.category === "verification") {
        const { suiteId, cases, category } = params;
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
          throw await throwCaseNameConflict(
            err,
            () =>
              db
                .select({ name: VerificationCaseTable.name })
                .from(VerificationCaseTable)
                .where(eq(VerificationCaseTable.suiteId, suiteId)),
            cases,
            suiteId,
          );
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

      if (params.category === "evaluation") {
        const { suiteId, cases, category } = params;
        const [suiteRow] = await db
          .select({
            id: EvalSuiteTable.id,
            visibility: EvalSuiteTable.visibility,
            createdBy: EvalSuiteTable.createdBy,
            evaluatorAgentId: EvalSuiteTable.evaluatorAgentId,
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
          throw await throwCaseNameConflict(
            err,
            () =>
              db
                .select({ name: EvalCaseTable.name })
                .from(EvalCaseTable)
                .where(eq(EvalCaseTable.suiteId, suiteId)),
            cases,
            suiteId,
          );
        }

        const createdCases: CreatedCaseItem[] = inserted.map((row) => ({
          id: row.id,
          name: row.name,
          enabled: false,
          assertionCount: Array.isArray(row.assertions) ? row.assertions.length : 0,
        }));

        // Non-blocking config warning: judge-dependent assertions under a suite
        // with no evaluator agent return `errored` when run (never a silent pass).
        const warnings: string[] = [];
        if (!suiteRow.evaluatorAgentId && cases.some((c) => containsJudgeDependentAssertions(c.assertions))) {
          warnings.push(WARNING_EVALUATOR_MISSING);
        }

        return {
          category,
          suiteId,
          createdCount: createdCases.length,
          cases: createdCases,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }

      if (params.category === "web-auto") {
        const { suiteId, cases, category } = params;
        const [suiteRow] = await db
          .select({
            id: WebAutoSuiteTable.id,
            visibility: WebAutoSuiteTable.visibility,
            createdBy: WebAutoSuiteTable.createdBy,
            evaluatorAgentId: WebAutoSuiteTable.evaluatorAgentId,
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

        let inserted: Array<{ id: number; name: string; assertions: unknown }>;
        try {
          inserted = await db.transaction(async (tx) => {
            return tx
              .insert(WebAutoCaseTable)
              .values(
                cases.map((c) => ({
                  suiteId,
                  name: c.name,
                  input: {
                    script: c.script ?? "",
                    steps: c.steps ?? "",
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
        } catch (err) {
          throw await throwCaseNameConflict(
            err,
            () =>
              db
                .select({ name: WebAutoCaseTable.name })
                .from(WebAutoCaseTable)
                .where(eq(WebAutoCaseTable.suiteId, suiteId)),
            cases,
            suiteId,
          );
        }

        const createdCases: CreatedCaseItem[] = inserted.map((row) => ({
          id: row.id,
          name: row.name,
          enabled: false,
          assertionCount: Array.isArray(row.assertions) ? row.assertions.length : 0,
        }));

        // Same config warning as the evaluation branch: judge-dependent
        // assertions under a suite with no evaluator agent return `errored`
        // when run (never a silent pass).
        const warnings: string[] = [];
        if (!suiteRow.evaluatorAgentId && cases.some((c) => containsJudgeDependentAssertions(c.assertions))) {
          warnings.push(WARNING_EVALUATOR_MISSING);
        }

        return {
          category,
          suiteId,
          createdCount: createdCases.length,
          cases: createdCases,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }

      // Exhaustive over the discriminated union — unreachable safety net.
      throw new Error("Unsupported category.");
    },
  });
}
