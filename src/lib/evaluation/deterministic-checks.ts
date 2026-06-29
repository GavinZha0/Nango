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

// ─── Input ──────────────────────────────────────────────────────────

export interface DeterministicCheckInput {
  /** Concatenated agent response text (all turns). */
  agentText: string;
  /** Tool names the agent actually called (from entity_run_event). */
  actualToolCalls: string[];
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

/**
 * Run all deterministic checks and produce placeholder entries for
 * LLM-judged fields. The returned `results` array matches the order
 * in `buildCriteriaChecklist` (UI-side) so the two are visually
 * aligned.
 */
export function runDeterministicChecks(
  criteria: EvalCriteria,
  input: DeterministicCheckInput,
): DeterministicCheckOutput {
  const results: CriteriaCheckResult[] = [];
  let passedCount = 0;
  let totalCount = 0;

  const textLower = input.agentText.toLowerCase();

  // ── LLM-evaluated (placeholders — evaluator fills these) ────────

  if (criteria.expectation) {
    results.push({
      label: criteria.expectation,
      kind: "expectation",
      passed: null,
      score: null,
    });
  }

  for (const a of criteria.assertions ?? []) {
    results.push({ label: a, kind: "assertion", passed: null });
  }

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
