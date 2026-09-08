import { z } from "zod";
import type { TestCategory } from "../types";

export interface CaseFieldRule {
  field: string;
  message: string;
}

/**
 * Matrix of inapplicable fields per category with actionable remediation guidance.
 * Shared between create_test_cases and update_test_case to prevent rule drift.
 */
export const CASE_DISALLOWED_FIELDS: Record<TestCategory, CaseFieldRule[]> = {
  evaluation: [
    {
      field: "toolName",
      message:
        "Field 'toolName' is not permitted in 'evaluation' cases. Evaluation suites test conversational AI agents; use 'turns' (array of user prompt strings) instead of 'toolName'/'input'.",
    },
    {
      field: "input",
      message:
        "Field 'input' is not permitted in 'evaluation' cases. Evaluation suites test conversational AI agents; use 'turns' (array of user prompt strings) instead of 'toolName'/'input'.",
    },
    {
      field: "script",
      message:
        "Field 'script' is not permitted in 'evaluation' cases. Script execution is exclusive to 'web-auto'; use 'turns' (array of user prompt strings) for conversational evaluation.",
    },
    {
      field: "steps",
      message:
        "Field 'steps' is not permitted in 'evaluation' cases. Steps are exclusive to 'web-auto'; use 'turns' (array of user prompt strings) for conversational evaluation.",
    },
  ],
  "web-auto": [
    {
      field: "turns",
      message:
        "Field 'turns' is not permitted in 'web-auto' cases. Web-auto suites test browser flows; provide 'script' (Playwright async (page) => {...}) and optional 'steps' instead.",
    },
    {
      field: "toolName",
      message:
        "Field 'toolName' is not permitted in 'web-auto' cases. The target Playwright MCP server is bound at the suite level via mcpServerId; each case takes 'script' and 'steps'.",
    },
    {
      field: "input",
      message:
        "Field 'input' is not permitted in 'web-auto' cases. Web-auto suites execute Playwright scripts; provide 'script' (Playwright async (page) => {...}) and optional 'steps' instead.",
    },
  ],
  verification: [
    {
      field: "turns",
      message:
        "Field 'turns' is not permitted in 'verification' cases. Verification suites test discrete MCP tools; provide 'toolName' and optional 'input' instead.",
    },
    {
      field: "script",
      message:
        "Field 'script' is not permitted in 'verification' cases. Playwright 'script' is exclusive to 'web-auto'; provide 'toolName' and optional 'input' for MCP tool verification.",
    },
    {
      field: "steps",
      message:
        "Field 'steps' is not permitted in 'verification' cases. Steps are exclusive to 'web-auto'; provide 'toolName' and optional 'input' for MCP tool verification.",
    },
  ],
};

/**
 * Validates that an item does not contain fields that belong strictly to other test categories.
 * Attaches structured Zod issues to `ctx` with actionable remediation guidance.
 *
 * @param category The active test category ('verification' | 'evaluation' | 'web-auto')
 * @param item The record being validated (single case item or update payload)
 * @param ctx The Zod refinement context
 * @param basePath Prefix path for the issue (e.g. `["cases", i]` or `[]`)
 */
export function refineDisallowedCaseFields(
  category: TestCategory,
  item: Record<string, unknown>,
  ctx: z.RefinementCtx,
  basePath: Array<string | number> = [],
): void {
  const rules = CASE_DISALLOWED_FIELDS[category];
  if (!rules) return;

  for (const { field, message } of rules) {
    if (item[field] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: [...basePath, field],
      });
    }
  }
}
