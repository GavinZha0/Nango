import { assertionSpecSchema, isJudgeDependentType } from "@/lib/assertions/types";

/** Standard warning for suites that hold llm_judge/expectation assertions but
 *  bind no evaluator agent — such cases return `errored` (never a silent pass). */
export const WARNING_EVALUATOR_MISSING =
  "Suite has no evaluatorAgentId: cases with llm_judge/expectation assertions return 'errored' when run. Bind an evaluator agent or keep only deterministic assertions.";

/** True when any assertion requires an LLM evaluator agent (llm_judge,
 *  expectation, llm_expectation). Used to warn when a suite has no evaluator. */
export function containsJudgeDependentAssertions(
  assertions: unknown[] | undefined | null,
): boolean {
  if (!Array.isArray(assertions)) return false;
  return assertions.some((a) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) return false;
    return isJudgeDependentType(String((a as Record<string, unknown>).type ?? ""));
  });
}

/**
 * Normalizes common model formatting aliases and performs lightweight
 * validation against the universal assertion specification schema.
 */
export function normalizeAndValidateAssertions(
  rawAssertions: unknown[],
  caseName: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(rawAssertions) || rawAssertions.length === 0) {
    return [];
  }

  const validatedList: Array<Record<string, unknown>> = [];

  for (let i = 0; i < rawAssertions.length; i++) {
    const raw = rawAssertions[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `Invalid assertion at index #${i} in case '${caseName}': assertion must be a non-empty JSON object with a 'type' property.`,
      );
    }

    const item = { ...(raw as Record<string, unknown>) };

    // 1. Auto-normalize common field aliases or type nicknames
    if (item.type === "js" || item.type === "javascript") {
      item.type = "js_expression";
    } else if (item.type === "schema") {
      item.type = "json_schema";
    }

    if (item.type === "jsonpath" && !item.path && typeof item.expression === "string") {
      item.path = item.expression;
    }

    // 2. Validate against system assertion specification
    const parsed = assertionSpecSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? "unsupported format";
      throw new Error(
        `Invalid assertion at index #${i} in case '${caseName}': ${issue}. Supported assertion types are: 'js_expression' (expression), 'jsonpath' (path, operator, expected), 'json_schema' (schema), 'metric' (metric, operator, threshold), 'tool_call' (toolName), 'llm_judge' (expectation).`,
      );
    }

    validatedList.push(item);
  }

  return validatedList;
}
