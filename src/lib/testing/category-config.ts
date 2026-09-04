import "server-only";

import {
  VerificationSuiteTable,
  VerificationCaseTable,
  EvalSuiteTable,
  EvalCaseTable,
  WebAutoSuiteTable,
  WebAutoCaseTable,
} from "@/lib/db/schema";
import type { TestCategory } from "./types";

/**
 * Per-category table + label bindings shared by the tester tools.
 *
 * Centralizes the "three branches differ only by table / display name"
 * duplication so a category branch cannot drift from the others (e.g. one
 * branch forgetting the RBAC check or error label). Keys are the `TestCategory`
 * discriminant values.
 */
export const CASE_CATEGORY_CONFIG = {
  verification: {
    label: "Verification",
    caseTable: VerificationCaseTable,
    suiteTable: VerificationSuiteTable,
  },
  evaluation: {
    label: "Evaluation",
    caseTable: EvalCaseTable,
    suiteTable: EvalSuiteTable,
  },
  "web-auto": {
    label: "Web Auto",
    caseTable: WebAutoCaseTable,
    suiteTable: WebAutoSuiteTable,
  },
} as const;

export type CaseCategory = TestCategory;
export type CaseCategoryConfig = (typeof CASE_CATEGORY_CONFIG)[CaseCategory];
