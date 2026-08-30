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

import type { EvalCriteria, CriteriaCheckResult } from "./types";
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
    outputTokens: number;
    toolCallCount: number;
  };
}

// ─── Output ─────────────────────────────────────────────────────────

export interface DeterministicCheckOutput {
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
    case "jsonpath_equals": {
      const path = spec.path || "path";
      const op = "operator" in spec ? spec.operator : "==";
      if (op === "exists") return `${path} exists`;
      return `${path} ${op} ${JSON.stringify(spec.expected)}`;
    }
    case "js_expression":
      return spec.expression;
    case "tool_call": {
      const count = spec.expectedCalls !== undefined ? spec.expectedCalls : 1;
      if (count === 0) return `forbidden tool: ${spec.toolName}`;
      return `tool: ${spec.toolName}${count > 1 ? ` (>= ${count} calls)` : ""}`;
    }
    case "metric":
      return `${spec.metric} ${spec.operator} ${spec.threshold}`;
    case "json_schema":
      return "JSON Schema validation";
    case "llm_judge":
    case "expectation":
    case "llm_expectation":
      return spec.expectation;
    default:
      return (spec as { type: string }).type;
  }
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
    const targetPayload = input.structuredPayload ?? { text: input.agentText };
    const outcome = evaluateAssertions(targetPayload, assertions, {
      actualToolCallNames: input.actualToolCalls,
      toolCalls: input.toolCalls,
      metrics: input.metrics,
    });

    for (const r of outcome.deterministicResults) {
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

  if (criteria.max_output_tokens !== undefined) {
    const passed = input.metrics.outputTokens <= criteria.max_output_tokens;
    results.push({
      label: `output tokens \u2264 ${criteria.max_output_tokens}`,
      kind: "metric",
      passed,
      actual: `${input.metrics.outputTokens}`,
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
