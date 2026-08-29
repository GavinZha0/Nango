/**
 * Web Auto subsystem — public type surface.
 *
 * Client-safe: no `server-only`, no Node-only imports.
 *
 * Hybrid execution engine combining:
 * - Deterministic MCP execution (Playwright via browser_run_code_unsafe)
 * - Deterministic assertions (json_schema, js_expression) 
 * - LLM evaluation (natural language expectations via evaluator agent)
 *
 * See docs/web-auto.md.
 */

import type {
  AssertionSpec,
  AssertionResult,
  ErrorEnvelope,
} from "@/lib/verification/types";
import type {
  WebAutoSuiteEntity,
  WebAutoCaseEntity,
} from "@/lib/db/schema";

/** Web Auto Case Input structure */
export interface WebAutoInput {
  script?: string;
  steps?: string;
  [key: string]: unknown;
}

/** Base verification assertion types (reused) */
export type {
  AssertionSpec,
  AssertionResult,
  ErrorEnvelope,
};

/** Web Auto-specific assertion: natural language expectation evaluated by LLM */
export interface ExpectationAssertion {
  type: "expectation" | "llm_expectation";
  /** Natural language description of expected outcome.
   *  Example: "Success toast banner should be visible with 'Saved' message" */
  expectation?: string;
  description?: string;
  /** Optional reference screenshot/base64 for visual comparison */
  referenceImage?: string;
  /** Additional context for the evaluator (business rules, acceptance criteria) */
  context?: string[];
}

/** Extended assertion spec for Web Auto (verification types + expectation) */
export type WebAutoAssertionSpec = AssertionSpec | ExpectationAssertion;

/** Extended assertion result for Web Auto */
export interface WebAutoAssertionResult extends AssertionResult {
  /** For expectation assertions, includes LLM evaluation details */
  llmScore?: number;
  llmFeedback?: string;
}

/** Structured extraction output for successful Playwright MCP execution */
export interface NormalizedWebAutoOutput {
  /** The pure return value of the executed script */
  result: unknown;
  /** Optional page metadata */
  page?: {
    url?: string;
    title?: string;
    console?: string;
  };
}

// --- Verdict structure (stored in web_auto_case_result.verdict jsonb) -----
export interface WebAutoVerdict {
  /** Deterministic assertion results (json_schema, js_expression, jsonpath_equals) */
  deterministic: {
    passed: boolean;
    results: AssertionResult[];
  };
  /** LLM evaluation results (expectation assertions) */
  llm?: {
    passed: boolean;
    score?: number;
    feedback?: string;
    expectationResults: Array<{
      expectation: string;
      score: number;
      feedback: string;
    }>;
  };
  /** Overall pass/fail (AND of deterministic and LLM if present) */
  overall: {
    passed: boolean;
    reason: string;
  };
}

// --- Execution outcome (internal runner result) ---------------------------

export interface WebAutoExecutionOutcome {
  status: "passed" | "failed" | "errored";
  /** Resolved input after variable substitution */
  resolvedInput?: Record<string, unknown>;
  /** Raw MCP tool output (Playwright script result) */
  executionOutput: unknown;
  /** Whether output was truncated for persistence */
  outputTruncated: boolean;
  /** Combined verdict from both assertion layers */
  verdict: WebAutoVerdict;
  /** Error envelope if execution failed */
  error: ErrorEnvelope | null;
  /** Execution timing */
  startedAt: number;
  durationMs: number;
}

// --- SSE frames (published on /api/runs/stream) ---------------------------

export interface WebAutoRunStartedFrame {
  topic: "web_auto_run";
  kind: "run_started";
  runId: string;
  suiteId: string;
  suiteName: string;
  totalCount: number;
}

export interface WebAutoCaseFinishedFrame {
  topic: "web_auto_run";
  kind: "case_finished";
  runId: string;
  caseId: number;
  status: "passed" | "failed" | "errored";
  durationMs: number;
  /** Present iff status !== "passed" */
  error?: ErrorEnvelope;
}

export interface WebAutoRunFinishedFrame {
  topic: "web_auto_run";
  kind: "run_finished";
  runId: string;
  suiteId: string;
  status: "passed" | "failed" | "errored";
  totalCount: number;
  passedCount: number;
  failedCount: number;
  erroredCount: number;
}

export type WebAutoFrame =
  | WebAutoRunStartedFrame
  | WebAutoCaseFinishedFrame
  | WebAutoRunFinishedFrame;

// --- Runner input interfaces -----------------------------------------------

export interface RunWebAutoCaseInput {
  caseId: number;
  suiteId: string;
  suite: WebAutoSuiteEntity;
  case: WebAutoCaseEntity | import("./storage").WebAutoCaseRunItem;
  /** Session user ID for permissions and runner dispatch */
  ownerId: string;
}

export interface RunWebAutoSuiteInput {
  suiteId: string;
  suite: WebAutoSuiteEntity;
  cases: WebAutoCaseEntity[];
  /** Session user ID */
  ownerId: string;
}

// --- Storage interfaces ----------------------------------------------------

export interface WriteWebAutoCaseResultInput {
  runId: string;
  caseId: number;
  status: "passed" | "failed" | "errored";
  executionOutput: unknown;
  verdict: WebAutoVerdict;
  error: ErrorEnvelope | null;
  startedAt: number;
  finishedAt?: number;
  durationMs: number;
}

export interface WriteWebAutoRunInput {
  suiteId: string;
  status: "running" | "passed" | "failed" | "errored";
  passed: number;
  failed: number;
  errored: number;
  createdBy: string;
}
