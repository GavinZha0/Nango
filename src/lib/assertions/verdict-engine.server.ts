/**
 * Universal Assertion Subsystem — Case Verdict Engine.
 *
 * Implements the unified verdict decision logic across all automated test
 * frameworks (Evaluation, Web Auto, Verification):
 * 1. Evaluates deterministic assertions first.
 * 2. If any deterministic assertion errors -> status = "errored".
 * 3. If any deterministic assertion fails -> status = "failed" (short-circuits LLM items, marked skipped).
 * 4. If all deterministic pass:
 *    - Evaluates LLM items (llm_dim, llm_custom).
 *    - If evaluator unconfigured -> status = "errored".
 *    - If evaluator errored -> status = "errored".
 *    - If min(LLM scores) >= threshold -> status = "passed", else "failed".
 *    - Pure deterministic test -> status = "passed".
 *
 * Returns 1:1 aligned, self-contained AssertionResult[] array.
 * Never throws.
 *
 * See docs/evaluation.md and docs/verification.md.
 */

import "server-only";

import type {
  AssertionResult,
  AssertionSpec,
  JsExpressionAssertion,
  JsonPathAssertion,
  LlmCustomAssertion,
  LlmDimAssertion,
  MetricAssertion,
  ToolCallAssertion,
} from "./types";

export interface DetermineVerdictOptions {
  assertions: readonly AssertionSpec[];
  deterministicResults: AssertionResult[];
  llmScores?: Array<{ index: number; score: number; reason?: string }>;
  evaluatorConfigured?: boolean;
  evaluatorError?: string;
  threshold?: number;
  evaluatorFeedback?: string;
}

export interface CaseVerdictOutcome {
  status: "passed" | "failed" | "errored";
  assertionResults: AssertionResult[];
  feedback?: string;
  minLlmScore?: number;
}

/**
 * Deterministically compute the verdict and unified assertion results for a test case.
 */
export function determineCaseVerdict(options: DetermineVerdictOptions): CaseVerdictOutcome {
  const {
    assertions,
    deterministicResults,
    llmScores = [],
    evaluatorConfigured = true,
    evaluatorError,
    threshold = 3,
    evaluatorFeedback,
  } = options;

  const detMap = new Map<number, AssertionResult>();
  for (const res of deterministicResults) {
    detMap.set(res.index, res);
  }

  const llmScoreMap = new Map<number, { score: number; reason?: string }>();
  for (const item of llmScores) {
    llmScoreMap.set(item.index, item);
  }

  // 1. Check deterministic assertions for errors or failures
  let anyDeterministicError = false;
  let anyDeterministicFailed = false;

  for (const res of deterministicResults) {
    if (res.errored) {
      anyDeterministicError = true;
    } else if (!res.ok) {
      anyDeterministicFailed = true;
    }
  }

  const assertionResults: AssertionResult[] = [];
  const recordedLlmScores: number[] = [];

  // Short-circuit condition: deterministic failed or errored
  const deterministicFailedOrErrored = anyDeterministicError || anyDeterministicFailed;

  for (let i = 0; i < assertions.length; i++) {
    const spec = assertions[i];

    if (spec.type === "llm_dim" || spec.type === "llm_custom") {
      const isDim = spec.type === "llm_dim";
      const dimSpec = isDim ? (spec as LlmDimAssertion) : undefined;
      const customSpec = !isDim ? (spec as LlmCustomAssertion) : undefined;

      const baseResult: AssertionResult = {
        index: i,
        type: spec.type,
        ok: false,
        dim: dimSpec?.dim,
        expectation: customSpec?.expectation,
        unexpectation: customSpec?.unexpectation,
        reference: customSpec?.reference,
      };

      if (deterministicFailedOrErrored) {
        // Deterministic failed -> short-circuit LLM assertions
        baseResult.skipped = true;
        baseResult.reason = "Skipped: deterministic assertion failed";
        baseResult.message = "Skipped due to deterministic assertion failure";
        assertionResults.push(baseResult);
        continue;
      }

      if (!evaluatorConfigured) {
        baseResult.skipped = true;
        baseResult.errored = true;
        baseResult.reason = "Evaluator agent is not configured";
        baseResult.message = "Evaluator agent is not configured";
        assertionResults.push(baseResult);
        continue;
      }

      if (evaluatorError) {
        baseResult.skipped = true;
        baseResult.errored = true;
        baseResult.reason = `Evaluator failed: ${evaluatorError}`;
        baseResult.message = `Evaluator failed: ${evaluatorError}`;
        assertionResults.push(baseResult);
        continue;
      }

      const scoreEntry = llmScoreMap.get(i);
      if (!scoreEntry) {
        baseResult.skipped = true;
        baseResult.errored = true;
        baseResult.reason = "Evaluator failed to submit score";
        baseResult.message = "Evaluator agent did not return a score for this item";
        assertionResults.push(baseResult);
        continue;
      }

      if (
        typeof scoreEntry.score !== "number" ||
        Number.isNaN(scoreEntry.score) ||
        scoreEntry.score < 1 ||
        scoreEntry.score > 5
      ) {
        baseResult.skipped = true;
        baseResult.errored = true;
        baseResult.reason = `Evaluator score ${scoreEntry.score} is invalid (expected integer between 1 and 5)`;
        baseResult.message = `Evaluator score ${scoreEntry.score} out of valid range (1-5)`;
        assertionResults.push(baseResult);
        continue;
      }

      const score = Math.round(scoreEntry.score);
      const passed = score >= threshold;

      baseResult.score = score;
      baseResult.reason = scoreEntry.reason;
      baseResult.feedback = scoreEntry.reason;
      baseResult.ok = passed;
      recordedLlmScores.push(score);
      assertionResults.push(baseResult);
      continue;
    }

    // Deterministic item
    const rawDetRes = detMap.get(i);
    const detRes: AssertionResult = rawDetRes
      ? { ...rawDetRes }
      : {
          index: i,
          type: spec.type,
          ok: false,
          errored: true,
          message: "Missing deterministic evaluation result",
        };

    // Guarantee self-contained snapshot readability without external spec
    if (spec.type === "tool_call") {
      const tc = spec as ToolCallAssertion;
      const expCalls = detRes.expectedCalls ?? (tc.expectedCalls !== undefined ? tc.expectedCalls : 1);
      detRes.toolName = detRes.toolName ?? tc.toolName;
      detRes.expectedCalls = expCalls;
      detRes.operator = detRes.operator ?? tc.operator;
      detRes.target = detRes.target ?? tc.target ?? "calls";
      if (detRes.expected === undefined) {
        detRes.expected = tc.expectedArgs !== undefined
          ? tc.expectedArgs
          : `${detRes.target} ${tc.operator} ${expCalls}`;
      }
    } else if (spec.type === "metric") {
      const ma = spec as MetricAssertion;
      detRes.metric = detRes.metric ?? ma.metric;
      if (detRes.expected === undefined) {
        detRes.expected = `${ma.operator} ${ma.threshold}`;
      }
    } else if (spec.type === "js_expression") {
      detRes.expression = detRes.expression ?? (spec as JsExpressionAssertion).expression;
    } else if (spec.type === "jsonpath") {
      detRes.path = detRes.path ?? (spec as JsonPathAssertion).path;
      if (detRes.expected === undefined) {
        detRes.expected = (spec as JsonPathAssertion).expected;
      }
    }
    assertionResults.push(detRes);
  }

  // Determine overall status
  let finalStatus: "passed" | "failed" | "errored";

  if (anyDeterministicError) {
    finalStatus = "errored";
  } else if (anyDeterministicFailed) {
    finalStatus = "failed";
  } else {
    // Deterministic passed! Now check LLM items
    const anyLlmError = assertionResults.some(
      (r) => (r.type === "llm_dim" || r.type === "llm_custom") && r.errored,
    );

    if (anyLlmError) {
      finalStatus = "errored";
    } else if (recordedLlmScores.length > 0) {
      const minScore = Math.min(...recordedLlmScores);
      finalStatus = minScore >= threshold ? "passed" : "failed";
    } else {
      // Pure deterministic test suite, and all passed
      finalStatus = "passed";
    }
  }

  const minLlmScore = recordedLlmScores.length > 0 ? Math.min(...recordedLlmScores) : undefined;

  let feedback = evaluatorFeedback;
  if (!feedback) {
    if (anyDeterministicFailed) {
      feedback = "Deterministic assertion checks failed. LLM evaluation skipped.";
    } else if (anyDeterministicError) {
      feedback = "One or more deterministic assertions errored during execution.";
    } else if (!evaluatorConfigured && assertions.some((s) => s.type === "llm_dim" || s.type === "llm_custom")) {
      feedback = "Case contains LLM assertions but no evaluator agent is configured.";
    } else if (finalStatus === "errored") {
      feedback = "One or more assertions errored during evaluation.";
    } else if (finalStatus === "passed") {
      feedback = "All assertion criteria satisfied.";
    } else if (finalStatus === "failed") {
      feedback = `Evaluation failed to meet threshold of ${threshold}. Min score: ${minLlmScore}.`;
    }
  }

  return {
    status: finalStatus,
    assertionResults,
    feedback,
    minLlmScore,
  };
}
