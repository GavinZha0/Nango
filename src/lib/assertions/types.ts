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
  expression: z.string().min(1).describe("JavaScript expression evaluated against sanitized `result`/`$`/`root`/`input`/`variables` (truthy = pass). Hardened, not a true isolate."),
});

export type JsExpressionAssertion = z.infer<typeof jsExpressionAssertionSchema>;

// ── 4. Tool Call Trajectory Assertion Schema ─────────────────────────────────

export const toolCallOperatorSchema = z.enum(["<", ">", "=="]);
export type ToolCallOperator = z.infer<typeof toolCallOperatorSchema>;

export const toolCallTargetSchema = z.enum(["calls", "failed", "blocked"]);
export type ToolCallTarget = z.infer<typeof toolCallTargetSchema>;

export const toolCallAssertionSchema = z.object({
  type: z.literal("tool_call"),
  toolName: z.string().min(1).describe("Name of the target tool"),
  operator: toolCallOperatorSchema.describe("Comparison operator (<, >, ==)"),
  target: toolCallTargetSchema.optional().describe("Target metric to evaluate ('calls' | 'failed' | 'blocked'). Default is 'calls'"),
  expectedCalls: z.number().int().min(0).optional().describe("Expected count threshold"),
  expectedArgs: z.record(z.string(), z.unknown()).optional().describe("Key-value subset expected in tool call args"),
});

export type ToolCallAssertion = z.infer<typeof toolCallAssertionSchema>;

export interface AssertionToolCallSummary {
  totalCalls: number;
  failureCount: number;
  blockedCount: number;
  toolFrequency?: Record<string, number>;
  abnormalDetails?: Array<{
    toolName: string;
    status: "failed" | "blocked";
    code?: string;
    reason?: string;
  }>;
}

// ── 5. Metric & Performance Assertion Schema ─────────────────────────────────

export const metricNameSchema = z.enum([
  "duration_s",
  "output_tokens",
  "total_tool_calls",
  "tool_failures",
  "tool_blocked",
]);

export type MetricName = z.infer<typeof metricNameSchema>;

export const metricOperatorSchema = z.enum(["<", ">", "=="]);

export type MetricOperator = z.infer<typeof metricOperatorSchema>;

export const metricAssertionSchema = z.object({
  type: z.literal("metric"),
  metric: metricNameSchema.describe("Target metric key"),
  operator: metricOperatorSchema.describe("Comparison operator (<, >, ==)"),
  threshold: z.number().describe("Numerical threshold limit"),
});

export type MetricAssertion = z.infer<typeof metricAssertionSchema>;

// ── 6. LLM Dimensions & Custom Semantic Assertion Schemas ────────────────────

export const llmDimAssertionSchema = z.object({
  type: z.literal("llm_dim"),
  dim: z.string().min(1).describe("Predefined evaluation dimension ID, e.g. task-completion, safety, fluency, faithfulness, tool-correctness, code-quality, format-compliance, tone-persona"),
});

export type LlmDimAssertion = z.infer<typeof llmDimAssertionSchema>;

export const llmCustomAssertionSchema = z.object({
  type: z.literal("llm_custom"),
  expectation: z.string().min(1).optional().describe("Natural language expected behavior or outcome"),
  unexpectation: z.string().min(1).optional().describe("Natural language prohibited or unexpected behavior"),
  reference: z.string().min(1).optional().describe("Ground truth reference context"),
  context: z.array(z.string()).optional().describe("Supplementary context notes"),
  referenceImage: z.string().optional().describe("Visual reference screenshot (Web Auto)"),
});

export type LlmCustomAssertion = z.infer<typeof llmCustomAssertionSchema>;

// ── 7. Discriminated Union & Array Schemas ───────────────────────────────────

export const assertionSpecSchema = z.discriminatedUnion("type", [
  jsonPathAssertionSchema,
  jsonSchemaAssertionSchema,
  jsExpressionAssertionSchema,
  toolCallAssertionSchema,
  metricAssertionSchema,
  llmDimAssertionSchema,
  llmCustomAssertionSchema,
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
  /** Dimension ID if this is an llm_dim assertion */
  dim?: string;
  /** Type-specific metadata */
  path?: string;
  expected?: unknown;
  actual?: unknown;
  /** Deterministic snapshot metadata for self-contained inspection */
  toolName?: string;
  expectedCalls?: number;
  operator?: string;
  target?: string;
  metric?: string;
  expression?: string;
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
   * True when the assertion itself failed to evaluate due to a configuration
   * error (e.g. invalid syntax, schema compilation failure, execution timeout,
   * or unsupported type), rather than the target data failing the assertion.
   */
  errored?: boolean;
  /**
   * True when this assertion was NOT evaluated (e.g. an llm_custom/llm_dim row whose
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
 * Standard reason attached to skipped LLM rows and to the error envelope
 * when a case requires LLM evaluation but its suite binds no evaluator agent.
 * Shared across Evaluation & Web Auto so both modules describe the condition
 * identically (config problem — never a 0-score "model was bad" signal).
 */
export const REASON_EVALUATOR_NOT_CONFIGURED =
  "Evaluator agent is not configured; the LLM portion of this case was not evaluated.";

/** Reason on LLM rows gated out by a deterministic assertion failure. */
export const REASON_SKIPPED_DETERMINISTIC_GATE =
  "Skipped: deterministic assertion(s) failed before this item was evaluated.";

/** Error message when an eval suite selects dimensions but binds no evaluator. */
export const REASON_DIMENSIONS_REQUIRE_EVALUATOR =
  "Suite dimensions require an evaluator agent; no evaluatorAgentId is configured.";

/**
 * Assertion types evaluated by an LLM evaluator agent rather than by code.
 * Single source of truth for the LLM assertion type set.
 */
export type LlmAssertionType = "llm_dim" | "llm_custom";
export type JudgeDependentType = LlmAssertionType;

/**
 * True for assertion types that are evaluated by an LLM evaluator agent:
 * `llm_dim` and `llm_custom`.
 */
export function isLlmAssertionType(type: string): type is LlmAssertionType {
  return type === "llm_dim" || type === "llm_custom";
}

export const isJudgeDependentType = isLlmAssertionType;

// ── 9. Category Assertion-Type Contract ─────────────────────────────────────

/** Canonical assertion type names. */
export type AssertionTypeName =
  | "jsonpath"
  | "json_schema"
  | "js_expression"
  | "tool_call"
  | "metric"
  | "llm_dim"
  | "llm_custom";

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
  verification: ["jsonpath", "json_schema", "js_expression", "metric"],
  evaluation: ["jsonpath", "js_expression", "tool_call", "metric", "llm_dim", "llm_custom"],
  "web-auto": ["js_expression", "jsonpath", "metric", "llm_custom"],
};

/**
 * Single source of truth for the metric names each test category supports.
 * Verification only evaluates duration_s for single MCP tool execution,
 * whereas Evaluation supports multi-turn dialogue metrics (tokens, tool calls).
 */
export const CATEGORY_METRIC_MAPPING: Record<
  TestCategoryName,
  readonly MetricName[]
> = {
  verification: ["duration_s"],
  evaluation: [
    "duration_s",
    "output_tokens",
    "total_tool_calls",
    "tool_failures",
    "tool_blocked",
  ],
  "web-auto": ["duration_s"],
};
