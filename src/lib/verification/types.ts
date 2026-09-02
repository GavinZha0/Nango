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

import type {
  AssertionSpec,
  AssertionResult,
  AssertionType,
  JsonSchemaAssertion,
  JsonPathAssertion,
  JsExpressionAssertion,
} from "@/lib/assertions";

export type {
  AssertionSpec,
  AssertionResult,
  AssertionType,
  JsonSchemaAssertion,
  JsonPathAssertion,
  JsExpressionAssertion,
};

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
  suiteId?: string;
  suiteName?: string;
  mcpServerId?: string;
  serverName?: string;
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
  resolvedInput?: Record<string, unknown>;
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
