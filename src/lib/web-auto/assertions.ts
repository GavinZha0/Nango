/**
 * Web Auto — deterministic assertion layer.
 *
 * Reuses verification's assertion evaluation logic (json_schema, js_expression, jsonpath_equals)
 * but adapted for Web Auto's extended assertion types (excludes expectation assertions which are
 * handled by the LLM evaluation layer).
 *
 * See docs/web-auto.md.
 */

import "server-only";

import { runAssertions } from "@/lib/verification/assertions";
import type { AssertionSpec, AssertionResult } from "@/lib/verification/types";
import type { WebAutoAssertionSpec } from "./types";

/**
 * Run deterministic assertions (excluding expectation assertions).
 * 
 * @param executionOutput - The MCP tool execution output
 * @param assertions - All assertions (including expectation type)
 * @param resolvedInput - Resolved input with variable substitution
 * @param runContext - Additional context for template substitution
 * @returns Assertion results for deterministic assertions only
 */
export function runDeterministicAssertions(
  executionOutput: unknown,
  assertions: readonly WebAutoAssertionSpec[],
  resolvedInput?: Record<string, unknown>,
  runContext?: Record<string, unknown>,
): {
  results: AssertionResult[];
  passed: boolean;
} {
  // Filter out expectation assertions (handled by LLM layer)
  const deterministicAssertions: AssertionSpec[] = assertions.filter(
    (assertion): assertion is AssertionSpec =>
      assertion.type !== "expectation" && assertion.type !== "llm_expectation"
  );

  // If executionOutput is structured { result, page }, use result as the target payload
  let targetPayload = executionOutput;
  const mergedContext: Record<string, unknown> = { ...runContext };

  if (
    typeof executionOutput === "object" &&
    executionOutput !== null &&
    "result" in executionOutput
  ) {
    const norm = executionOutput as { result?: unknown; page?: unknown };
    targetPayload = norm.result;
    mergedContext.root = executionOutput;
    if (norm.page) mergedContext.page = norm.page;
  }

  // Use verification's assertion runner
  const assertionResults = runAssertions(
    targetPayload,
    deterministicAssertions,
    resolvedInput,
    mergedContext,
  );

  const allPassed = assertionResults.every((r) => r.ok);

  return {
    results: assertionResults,
    passed: allPassed,
  };
}

/**
 * Extract expectation assertions for LLM evaluation layer.
 */
export function extractExpectationAssertions(
  assertions: readonly WebAutoAssertionSpec[],
): Array<{ expectation: string; referenceImage?: string; context?: string[] }> {
  return assertions
    .filter(
      (assertion): assertion is WebAutoAssertionSpec & { type: "expectation" | "llm_expectation" } =>
        assertion.type === "expectation" || assertion.type === "llm_expectation"
    )
    .map((assertion) => {
      const exp = "expectation" in assertion && typeof assertion.expectation === "string"
        ? assertion.expectation
        : "description" in assertion && typeof assertion.description === "string"
        ? assertion.description
        : "";
      return {
        expectation: exp,
        referenceImage: "referenceImage" in assertion ? assertion.referenceImage : undefined,
        context: "context" in assertion ? assertion.context : undefined,
      };
    })
    .filter((item) => item.expectation.trim().length > 0);
}
