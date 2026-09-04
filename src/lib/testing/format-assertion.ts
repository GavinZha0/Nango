import type { AssertionResult, AssertionSpec } from "@/lib/assertions";
import type { CaseAssertionResultItem } from "./types";

/**
 * Build a human/LLM-readable `description` for an assertion result.
 *
 * Shared by `run_test_case` (which has the original assertion specs) and
 * `get_test_results` (which reads historical results and has no specs), so the
 * two surfaces describe the same assertion identically.
 *
 * When `spec` is provided, the description is derived from the assertion
 * definition (the richest form). Otherwise it falls back to the result's own
 * `path`/`message` metadata.
 */
export function formatAssertionResultItem(
  result: AssertionResult,
  spec?: AssertionSpec,
): CaseAssertionResultItem {
  let description = result.type;
  if (spec) {
    if (spec.type === "js_expression") description = spec.expression;
    else if (spec.type === "jsonpath")
      description = `${spec.path} ${spec.operator ?? "=="} ${JSON.stringify(spec.expected)}`;
    else if (spec.type === "json_schema") description = "JSON Schema validation";
    else if (spec.type === "metric")
      description = `${spec.metric} ${spec.operator} ${spec.threshold}`;
    else if (spec.type === "tool_call") description = `Tool: ${spec.toolName}`;
    else if ("expectation" in spec && spec.expectation) description = spec.expectation;
  } else if (result.path) {
    description = `${result.path} == ${JSON.stringify(result.expected)}`;
  } else if (result.message) {
    description = result.message
      .replace(/^JS Expression:\s*/i, "")
      .replace(/^Metric:\s*/i, "");
  }

  return {
    type: result.type,
    description,
    passed: Boolean(result.ok),
    message: result.message ?? result.reason ?? result.feedback ?? null,
  };
}
