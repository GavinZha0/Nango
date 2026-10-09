/**
 * Evaluation — deterministic criteria checks.
 *
 * Runs code-verifiable checks against the target agent's output and
 * execution metrics. Results are:
 *   1. Stored in `eval_case_result.criteria_results` for UI display.
 *   2. Fed into the evaluator prompt so the LLM can reference them.
 *   3. Used to compute `deterministic_pass_rate` for the criteria
 *      score formula: `criteria_score = evaluator_score × pass_rate`.
 *
 * This module does NOT evaluate LLM-judged fields (`expectation`,
 * `assertions`) — those are handled by the evaluator agent. It
 * produces placeholder entries (passed=null) for them so the
 * returned array is a complete checklist matching the UI layout.
 *
 * See docs/evaluation.md.
 */

import "server-only";

import type { EvalCriteria, CriteriaCheckResult, ToolCallSummary } from "./types";
import { evaluateAssertions, type AssertionSpec } from "@/lib/assertions";

// ─── Input ──────────────────────────────────────────────────────────

export interface DeterministicCheckInput {
  /** Concatenated agent response text (all turns). */
  agentText: string;
  /** Tool names the agent actually called (from entity_run_event). */
  actualToolCalls: string[];
  /** Detailed tool calls if available */
  toolCalls?: Array<{ name: string; args?: unknown }>;
  /** Structured output if agent output was JSON */
  structuredPayload?: unknown;
  /** Runner-measured execution metrics. */
  metrics: {
    durationMs: number;
    outputChars: number;
    toolCallCount: number;
  };
  /** Suite-level literal variables for assertion evaluation */
  variables?: Record<string, unknown>;
  /** Structured tool invocation and audit summary */
  toolCallSummary?: ToolCallSummary;
  /** Individual turn assistant responses for scoped text matching */
  allAgentResponses?: string[];
  /** Total number of turns in the evaluation case */
  turnsCount?: number;
}

// ─── Output ─────────────────────────────────────────────────────────

export interface DeterministicCheckOutput {
  /** Standard assertion results for DB storage and UI rendering */
  assertionResults: import("@/lib/assertions").AssertionResult[];
  /** Partitioned LLM assertions */
  llmAssertions: Array<{ index: number; spec: import("@/lib/assertions").LlmDimAssertion | import("@/lib/assertions").LlmCustomAssertion }>;
  /** Full checklist — LLM items have `passed: null`, deterministic
   *  items have `passed: true/false`. */
  results: CriteriaCheckResult[];
  /** Number of deterministic items that passed. */
  passedCount: number;
  /** Total number of deterministic items (excludes LLM-judged). */
  totalCount: number;
  /** passedCount / totalCount (1.0 when totalCount is 0). */
  passRate: number;
}

// ─── Engine ─────────────────────────────────────────────────────────

function getAssertionDescription(spec: AssertionSpec): string {
  switch (spec.type) {
    case "jsonpath":
      return `JSONPath ${spec.path} ${spec.operator ?? "=="} ${JSON.stringify(spec.expected)}`;
    case "json_schema":
      return "JSON Schema Draft 2020-12 validation";
    case "js_expression":
      return spec.expression;
    case "tool_call": {
      const targetStr = spec.target && spec.target !== "calls" ? ` (${spec.target})` : "";
      return `Tool Call ${spec.toolName}${targetStr} ${spec.operator} ${spec.expectedCalls ?? 1}`;
    }
    case "metric":
      return `${spec.metric} ${spec.operator} ${spec.threshold}`;
    case "text_match":
      return `Text ${spec.operator} "${spec.expected}"${spec.caseSensitive ? " (case-sensitive)" : ""}`;
    case "llm_dim":
      return `Dim: ${spec.dim}`;
    case "llm_custom": {
      const label =
        spec.expectation ? spec.expectation :
        spec.unexpectation ? `[Unexpectation] ${spec.unexpectation}` :
        spec.reference ? `[Reference] ${spec.reference}` :
        "LLM Custom";
      return `LLM Custom: ${label}`;
    }
    default:
      return "Custom assertion check";
  }
}

/**
 * Tries to parse structured JSON from raw agent response text.
 * Supports direct JSON string and markdown code blocks (```json ... ```).
 */
export function tryExtractStructuredPayload(text: string): Record<string, unknown> | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  // 1. Direct JSON object/array
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        return Array.isArray(parsed) ? { items: parsed, result: parsed } : { ...parsed, result: parsed };
      }
    } catch {
      // not direct json
    }
  }
  // 2. Markdown code block ```json ... ```
  const match = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (match && match[1]) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed !== null && typeof parsed === "object") {
        return Array.isArray(parsed) ? { items: parsed, result: parsed } : { ...parsed, result: parsed };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Run all deterministic checks against assertions or legacy criteria.
 */
export function runDeterministicChecks(
  assertionsOrCriteria: AssertionSpec[] | EvalCriteria | unknown,
  input: DeterministicCheckInput,
): DeterministicCheckOutput {
  const results: CriteriaCheckResult[] = [];
  let passedCount = 0;
  let totalCount = 0;

  // Case A: Unified AssertionSpec[] array
  if (Array.isArray(assertionsOrCriteria)) {
    const assertions = assertionsOrCriteria as AssertionSpec[];
    const autoStructured = tryExtractStructuredPayload(input.agentText);
    const targetPayload =
      input.structuredPayload ??
      (autoStructured ? { ...autoStructured, text: input.agentText } : { text: input.agentText });
    const outcome = evaluateAssertions(targetPayload, assertions, {
      actualToolCallNames: input.actualToolCalls,
      toolCalls: input.toolCalls,
      metrics: input.metrics,
      variables: input.variables,
      toolCallSummary: input.toolCallSummary,
      turnResponses: input.allAgentResponses,
      turnsCount: input.turnsCount ?? input.allAgentResponses?.length,
    });

    const assertionResults = outcome.deterministicResults;

    for (const r of assertionResults) {
      const isOk = r.ok;
      const spec = assertions[r.index];
      const desc = spec ? getAssertionDescription(spec) : `${r.type} check`;
      results.push({
        label: desc,
        kind: r.type === "metric" ? "metric" : (r.type === "tool_call" ? "tool_call" : "assertion"),
        passed: isOk,
        ...(r.actual !== undefined ? { actual: typeof r.actual === "object" ? JSON.stringify(r.actual) : String(r.actual) } : {}),
        ...(r.message && r.message !== "value mismatch" && r.message !== "Expression returned falsy" ? { message: r.message } : {}),
      });
      totalCount++;
      if (isOk) passedCount++;
    }

    return {
      assertionResults,
      llmAssertions: outcome.llmAssertions,
      results,
      passedCount,
      totalCount,
      passRate: totalCount === 0 ? 1.0 : passedCount / totalCount,
    };
  }

  // Case B: Legacy EvalCriteria object
  const criteria = (assertionsOrCriteria ?? {}) as EvalCriteria;
  const textLower = input.agentText.toLowerCase();

  // ── Deterministic: keywords ─────────────────────────────────────

  for (const kw of criteria.expected_keywords ?? []) {
    const found = textLower.includes(kw.toLowerCase());
    results.push({
      label: `keyword: "${kw}"`,
      kind: "keyword",
      passed: found,
      ...(!found ? { actual: "not found" } : {}),
    });
    totalCount++;
    if (found) passedCount++;
  }

  for (const kw of criteria.unexpected_keywords ?? []) {
    const absent = !textLower.includes(kw.toLowerCase());
    results.push({
      label: `not: "${kw}"`,
      kind: "keyword",
      passed: absent,
      ...(!absent ? { actual: "found" } : {}),
    });
    totalCount++;
    if (absent) passedCount++;
  }

  // ── Deterministic: tool calls ───────────────────────────────────

  const actualSet = new Set(input.actualToolCalls);

  for (const tc of criteria.tool_calls ?? []) {
    const called = actualSet.has(tc);
    results.push({
      label: `tool: ${tc}`,
      kind: "tool_call",
      passed: called,
      ...(!called ? { actual: "not called" } : {}),
    });
    totalCount++;
    if (called) passedCount++;
  }

  // ── Deterministic: execution metrics ────────────────────────────

  if (criteria.max_duration_s !== undefined) {
    const actualSec = input.metrics.durationMs / 1000;
    const passed = actualSec <= criteria.max_duration_s;
    results.push({
      label: `duration \u2264 ${criteria.max_duration_s}s`,
      kind: "metric",
      passed,
      actual: `${actualSec.toFixed(1)}s`,
    });
    totalCount++;
    if (passed) passedCount++;
  }

  if (criteria.max_output_chars !== undefined) {
    const passed = input.metrics.outputChars <= criteria.max_output_chars;
    results.push({
      label: `output chars \u2264 ${criteria.max_output_chars}`,
      kind: "metric",
      passed,
      actual: `${input.metrics.outputChars}`,
    });
    totalCount++;
    if (passed) passedCount++;
  }

  if (criteria.max_tool_calls !== undefined) {
    const passed = input.metrics.toolCallCount <= criteria.max_tool_calls;
    results.push({
      label: `tool calls \u2264 ${criteria.max_tool_calls}`,
      kind: "metric",
      passed,
      actual: `${input.metrics.toolCallCount}`,
    });
    totalCount++;
    if (passed) passedCount++;
  }

  return {
    assertionResults: [],
    llmAssertions: [],
    results,
    passedCount,
    totalCount,
    passRate: totalCount === 0 ? 1.0 : passedCount / totalCount,
  };
}

/**
 * Format deterministic check results as a human-readable block for
 * injection into the evaluator prompt. LLM-judged items (passed=null)
 * are skipped — only code-verified results are included.
 */
export function formatChecksForPrompt(
  results: CriteriaCheckResult[],
): string {
  const lines = results
    .filter((r) => r.passed !== null)
    .map((r) => {
      const icon = r.passed ? "\u2713" : "\u2717";
      const suffix = r.actual !== undefined ? ` (actual: ${r.actual})` : "";
      return `${icon} ${r.label}${suffix}`;
    });

  if (lines.length === 0) return "";

  return [
    "DETERMINISTIC CHECK RESULTS (verified by code):",
    ...lines,
  ].join("\n");
}
