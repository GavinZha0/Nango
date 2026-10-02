/**
 * Shared test suite execution context for cross-case variable referencing.
 *
 * Collects case execution input and output data and registers them by normalized
 * case name and 3-digit numeric prefix alias (e.g. "010").
 *
 * See docs/verification.md, docs/evaluation.md, and docs/web-auto.md.
 */

import { normalizeCaseName } from "@/lib/assertions";

export interface SuiteCaseContextData {
  input?: unknown;
  output?: unknown;
}

/**
 * Register a completed test case's input and output in the suite execution context.
 *
 * Registers the case data under:
 * 1. Normalized case name (e.g. "010_login" -> "010_login")
 * 2. Numeric prefix alias if present (e.g. "010_login" -> "010")
 */
export function registerCaseInSuiteContext(
  suiteContext: Record<string, unknown>,
  caseName: string,
  data: SuiteCaseContextData,
): void {
  const normalizedKey = normalizeCaseName(caseName);
  if (!normalizedKey) return;

  const caseData = {
    input: data.input ?? {},
    output: data.output !== undefined && data.output !== null ? data.output : {},
  };

  suiteContext[normalizedKey] = caseData;

  const prefixMatch = normalizedKey.match(/^(\d+)/);
  if (prefixMatch) {
    suiteContext[prefixMatch[1]] = caseData;
  }
}
