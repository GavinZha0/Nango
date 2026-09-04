/**
 * Universal Assertion Subsystem — public type surface.
 *
 * Client-safe: no `server-only`, no drizzle, no Node-only imports.
 * Single source of truth for test assertions across Verification,
 * Web Auto, and Evaluation subsystems.
 *
 * See docs/verification.md and docs/evaluation.md.
 */

import { z } from "zod";

// ── 1. JSONPath Assertion Schema ─────────────────────────────────────────────

export const jsonPathOperatorSchema = z.enum([
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "matches",
  "exists",
]);

export type JsonPathOperator = z.infer<typeof jsonPathOperatorSchema>;

export const jsonPathAssertionSchema = z.object({
  type: z.literal("jsonpath"),
  path: z.string().min(1).describe("JSONPath query (e.g. $.data.user.id or cached)"),
  operator: jsonPathOperatorSchema.optional().describe("Comparison operator (defaults to '==')"),
  expected: z.unknown().optional().describe("Expected comparison target value"),
});

export type JsonPathAssertion = z.infer<typeof jsonPathAssertionSchema>;

// ── 2. JSON Schema Assertion Schema ──────────────────────────────────────────

export const jsonSchemaAssertionSchema = z.object({
  type: z.literal("json_schema"),
  schema: z.record(z.string(), z.unknown()).describe("JSON Schema Draft 2020-12 specification"),
});

export type JsonSchemaAssertion = z.infer<typeof jsonSchemaAssertionSchema>;

// ── 3. JS Expression Assertion Schema ────────────────────────────────────────

export const jsExpressionAssertionSchema = z.object({
  type: z.literal("js_expression"),
  expression: z.string().min(1).describe("JavaScript expression evaluated in sandbox (truthy = pass)"),
});

export type JsExpressionAssertion = z.infer<typeof jsExpressionAssertionSchema>;

// ── 4. Tool Call Trajectory Assertion Schema ─────────────────────────────────

export const toolCallAssertionSchema = z.object({
  type: z.literal("tool_call"),
  toolName: z.string().min(1).describe("Name of the required tool"),
  expectedCalls: z.number().int().min(0).optional().describe("Expected invocation count (default >= 1, 0 = forbidden)"),
  expectedArgs: z.record(z.string(), z.unknown()).optional().describe("Key-value subset expected in tool call args"),
});

export type ToolCallAssertion = z.infer<typeof toolCallAssertionSchema>;

// ── 5. Metric & Performance Assertion Schema ─────────────────────────────────

export const metricNameSchema = z.enum([
  "duration_s",
  "output_tokens",
  "total_tool_calls",
]);

export type MetricName = z.infer<typeof metricNameSchema>;

export const metricOperatorSchema = z.enum(["<", "<=", ">", ">=", "=="]);

export type MetricOperator = z.infer<typeof metricOperatorSchema>;

export const metricAssertionSchema = z.object({
  type: z.literal("metric"),
  metric: metricNameSchema.describe("Target metric key"),
  operator: metricOperatorSchema.describe("Comparison operator"),
  threshold: z.number().describe("Numerical threshold limit"),
});

export type MetricAssertion = z.infer<typeof metricAssertionSchema>;

// ── 6. LLM Judge / Semantic Assertion Schema ─────────────────────────────────

export const llmJudgeAssertionSchema = z.object({
  type: z.literal("llm_judge"),
  expectation: z.string().min(1).optional().describe("Natural language expected behavior or outcome"),
  unexpectation: z.string().min(1).optional().describe("Natural language prohibited or unexpected behavior"),
  reference: z.string().min(1).optional().describe("Ground truth reference context"),
  dimensionId: z.string().optional().describe("Optional evaluation dimension identifier"),
  context: z.array(z.string()).optional().describe("Supplementary context notes"),
  referenceImage: z.string().optional().describe("Visual reference screenshot (Web Auto)"),
});

export type LlmJudgeAssertion = z.infer<typeof llmJudgeAssertionSchema>;

export const llmExpectationAssertionSchema = z.object({
  type: z.literal("llm_expectation"),
  expectation: z.string().min(1),
  unexpectation: z.string().optional(),
  reference: z.string().optional(),
});

export type LlmExpectationAssertion = z.infer<typeof llmExpectationAssertionSchema>;

export const expectationAssertionSchema = z.object({
  type: z.literal("expectation"),
  expectation: z.string().min(1),
  unexpectation: z.string().optional(),
  reference: z.string().optional(),
});

export type ExpectationAssertion = z.infer<typeof expectationAssertionSchema>;

// ── 7. Discriminated Union & Array Schemas ───────────────────────────────────

export const assertionSpecSchema = z.discriminatedUnion("type", [
  jsonPathAssertionSchema,
  jsonSchemaAssertionSchema,
  jsExpressionAssertionSchema,
  toolCallAssertionSchema,
  metricAssertionSchema,
  llmJudgeAssertionSchema,
  llmExpectationAssertionSchema,
  expectationAssertionSchema,
]);

export const assertionsArraySchema = z.array(assertionSpecSchema);

export type AssertionSpec = z.infer<typeof assertionSpecSchema>;
export type AssertionType = AssertionSpec["type"];

// ── 8. Evaluation Verdict & Result Shapes ────────────────────────────────────

export interface AssertionResult {
  /** Index into the original `assertions` array */
  index: number;
  type: string;
  ok: boolean;
  /** Type-specific metadata */
  path?: string;
  expected?: unknown;
  actual?: unknown;
  /** Optional human-readable explanation */
  message?: string;
  /** LLM evaluation score (0-100) */
  score?: number;
  /** LLM evaluation explanation / reasoning */
  reason?: string;
  feedback?: string;
  llmScore?: number;
  llmFeedback?: string;
  expectation?: string;
  unexpectation?: string;
  reference?: string;
  dimensionId?: string;
  referenceImage?: string;
  errorSource?: string;
  details?: unknown;
  /**
   * True when this assertion was NOT evaluated (e.g. an llm_judge row whose
   * suite has no evaluator agent configured, or a judge row gated out by a
   * deterministic failure). Renders as "not evaluated", never as a scored
   * failure.
   * CONTRACT: only ever serialize `true`. Never write `skipped: false` for a
   * normal row — `undefined` keys drop out of jsonb on write, and a
   * `false` key injected on the client would break isDeepEqual dirty checks.
   */
  skipped?: boolean;
}

export interface ErrorEnvelope {
  source: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Standard reason attached to skipped llm_judge rows and to the error envelope
 * when a case requires LLM evaluation but its suite binds no evaluator agent.
 * Shared across Evaluation & Web Auto so both modules describe the condition
 * identically (config problem — never a 0-score "model was bad" signal).
 */
export const REASON_EVALUATOR_NOT_CONFIGURED =
  "Evaluator agent is not configured; the LLM judge portion of this case was not evaluated.";

/** Reason on llm_judge rows gated out by a deterministic assertion failure. */
export const REASON_SKIPPED_DETERMINISTIC_GATE =
  "Skipped: deterministic assertion(s) failed before this item was evaluated.";

/** Error message when an eval suite selects dimensions but binds no evaluator. */
export const REASON_DIMENSIONS_REQUIRE_EVALUATOR =
  "Suite dimensions require an evaluator agent; no evaluatorAgentId is configured.";

/**
 * Assertion types evaluated by an LLM evaluator agent rather than by code.
 * Single source of truth for the "judge-dependent" type set.
 */
export type JudgeDependentType = "llm_judge" | "expectation" | "llm_expectation";

/**
 * True for assertion types that are evaluated by an LLM evaluator agent rather
 * than by code: `llm_judge` plus the legacy `expectation` / `llm_expectation`
 * aliases. Shared so every module classifies "judge-dependent" identically.
 */
export function isJudgeDependentType(type: string): type is JudgeDependentType {
  return type === "llm_judge" || type === "expectation" || type === "llm_expectation";
}

// ── 9. Category Assertion-Type Contract ─────────────────────────────────────

/** Canonical assertion type names (legacy `expectation` variants excluded). */
export type AssertionTypeName =
  | "jsonpath"
  | "json_schema"
  | "js_expression"
  | "tool_call"
  | "metric"
  | "llm_judge";

export type TestCategoryName = "verification" | "evaluation" | "web-auto";

/**
 * Single source of truth for the assertion types each test category supports.
 * Consumed by `get_assertion_schema`, tester tool descriptions, and the tester
 * system prompt. See docs/test-automation-copilot.md.
 *
 * CONTRACT: runtime evaluators may tolerate a superset (e.g. json_schema on
 * evaluation/web-auto), but only the types listed here are contract-supported.
 */
export const CATEGORY_TYPE_MAPPING: Record<
  TestCategoryName,
  readonly AssertionTypeName[]
> = {
  verification: ["jsonpath", "json_schema", "js_expression"],
  evaluation: ["jsonpath", "js_expression", "llm_judge", "metric", "tool_call"],
  "web-auto": ["js_expression", "jsonpath", "llm_judge"],
};
