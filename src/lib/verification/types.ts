/**
 * Verification subsystem — public type surface.
 *
 * Client-safe: no `server-only`, no drizzle, no Node-only imports.
 * Re-uses the DB-shape unions exported from `@/lib/db/schema` so
 * the wire DTOs stay in lockstep with the table columns.
 *
 * See docs/verification.md.
 */

import type {
  VerificationSuiteCategory,
  VerificationRunStatus,
  VerificationCaseResultStatus,
  VerificationErrorSource,
} from "@/lib/db/schema";

export type {
  VerificationSuiteCategory,
  VerificationRunStatus,
  VerificationCaseResultStatus,
  VerificationErrorSource,
};

// --- Assertion specs (stored in test_case.assertions jsonb) -------------------

export interface JsonSchemaAssertion {
  type: "json_schema";
  /** JSON Schema Draft 2020-12 — evaluated by ajv 8. */
  schema: Record<string, unknown>;
}

export interface JsonPathEqualsAssertion {
  type: "jsonpath_equals";
  /** JSONPath expression, e.g. "$.data.user.id". */
  path: string;
  /** Deep-equal target. */
  expected: unknown;
}

export interface JsExpressionAssertion {
  type: "js_expression";
  /** JS expression evaluated in a `node:vm` sandbox with the tool
   *  result bound as `result`. Truthy = pass. */
  expression: string;
}

export type AssertionSpec =
  | JsonSchemaAssertion
  | JsonPathEqualsAssertion
  | JsExpressionAssertion;

export type AssertionType = AssertionSpec["type"];

// --- Assertion verdicts (stored in test_case_result.assertion_results jsonb) -

export interface AssertionResult {
  /** Index into the original `assertions` array. */
  index: number;
  type: AssertionType;
  ok: boolean;
  /** Type-specific context fields. */
  path?: string;
  expected?: unknown;
  actual?: unknown;
  /** Optional human-readable detail (validator error text, etc.). */
  message?: string;
}

// --- Error envelope (stored in test_case_result.error jsonb) -----------------

export interface ErrorEnvelope {
  source: VerificationErrorSource;
  message: string;
  details?: Record<string, unknown>;
}

// --- SSE frames (published on the runner event-bus per-owner channel) --------

export interface VerificationRunStartedFrame {
  topic: "verification_run";
  kind: "run_started";
  runId: string;
  suiteId: string;
  suiteName?: string;
  totalCount: number;
}

export interface VerificationCaseFinishedFrame {
  topic: "verification_run";
  kind: "case_finished";
  runId: string;
  caseId: number;
  status: VerificationCaseResultStatus;
  durationMs: number;
  /** Present iff `status !== "passed"`. */
  error?: ErrorEnvelope;
}

export interface VerificationRunFinishedFrame {
  topic: "verification_run";
  kind: "run_finished";
  runId: string;
  status: VerificationRunStatus;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  erroredCount: number;
  skippedCount: number;
}

export type VerificationFrame =
  | VerificationRunStartedFrame
  | VerificationCaseFinishedFrame
  | VerificationRunFinishedFrame;

// --- Single-case execution outcome (used by runner-mcp + orchestrator) -------

/** Outcome of evaluating one case against one tool invocation. The
 *  orchestrator persists this verbatim into `verification_case_result`. */
export interface CaseExecutionOutcome {
  status: VerificationCaseResultStatus;
  /** Tool / workflow output. NULL for cases that never produced one
   *  (transport throw, skipped). */
  resultPayload: unknown;
  resultTruncated: boolean;
  assertionResults: AssertionResult[];
  /** NULL when the case passed cleanly. */
  error: ErrorEnvelope | null;
  /** Wall-clock at which the case actually started executing (epoch ms).
   *  Persisted verbatim into `verification_case_result.started_at` so
   *  history-view timestamps reflect real execution time, not insert
   *  time (which used to be ≈ finishedAt because the row was only
   *  written after the case completed). */
  startedAt: number;
  durationMs: number;
}
