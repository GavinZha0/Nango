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

  // 1. Validate indices and detect duplicates/unknowns in deterministicResults
  const detMap = new Map<number, AssertionResult>();
  const duplicateDetIndices = new Set<number>();
  const unknownDetIndices: number[] = [];

  for (const res of deterministicResults) {
    if (typeof res.index !== "number" || res.index < 0 || res.index >= assertions.length) {
      unknownDetIndices.push(res.index);
      continue;
    }
    const spec = assertions[res.index];
    if (spec && (spec.type === "llm_dim" || spec.type === "llm_custom")) {
      unknownDetIndices.push(res.index);
      continue;
    }
    if (detMap.has(res.index)) {
      duplicateDetIndices.add(res.index);
    }
    detMap.set(res.index, res);
  }

  // 2. Validate indices and detect duplicates/unknowns in llmScores
  const llmScoreMap = new Map<number, { score: number; reason?: string }>();
  const duplicateLlmIndices = new Set<number>();
  const unknownLlmIndices: number[] = [];

  for (const item of llmScores) {
    if (typeof item.index !== "number" || item.index < 0 || item.index >= assertions.length) {
      unknownLlmIndices.push(item.index);
      continue;
    }
    const spec = assertions[item.index];
    if (spec && spec.type !== "llm_dim" && spec.type !== "llm_custom") {
      unknownLlmIndices.push(item.index);
      continue;
    }
    if (llmScoreMap.has(item.index)) {
      duplicateLlmIndices.add(item.index);
    }
    llmScoreMap.set(item.index, item);
  }

  // Pre-screen deterministic assertions to determine whether LLM items should be short-circuited
  let anyDeterministicError = unknownDetIndices.length > 0;
  let anyDeterministicFailed = false;

  for (let i = 0; i < assertions.length; i++) {
    const spec = assertions[i];
    if (spec.type !== "llm_dim" && spec.type !== "llm_custom") {
      if (duplicateDetIndices.has(i)) {
        anyDeterministicError = true;
      } else if (!detMap.has(i)) {
        anyDeterministicError = true;
      } else {
        const res = detMap.get(i)!;
        if (res.errored) {
          anyDeterministicError = true;
        } else if (!res.ok) {
          anyDeterministicFailed = true;
        }
      }
    }
  }

  const deterministicFailedOrErrored = anyDeterministicError || anyDeterministicFailed;

  // 3. Build 1:1 aligned, self-contained AssertionResult[] array for all declared assertions
  const assertionResults: AssertionResult[] = [];
  const recordedLlmScores: number[] = [];

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
        baseResult.skipped = true;
        baseResult.reason = anyDeterministicError
          ? "Skipped: deterministic assertion errored"
          : "Skipped: deterministic assertion failed";
        baseResult.message = anyDeterministicError
          ? "Skipped due to deterministic assertion error"
          : "Skipped due to deterministic assertion failure";
        assertionResults.push(baseResult);
        continue;
      }

      if (duplicateLlmIndices.has(i)) {
        baseResult.skipped = true;
        baseResult.errored = true;
        baseResult.reason = `Duplicate LLM evaluation score for index ${i}`;
        baseResult.message = `Duplicate LLM evaluation score for index ${i}`;
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
    let detRes: AssertionResult;
    if (duplicateDetIndices.has(i)) {
      detRes = {
        index: i,
        type: spec.type,
        ok: false,
        errored: true,
        message: `Duplicate deterministic evaluation result for index ${i}`,
      };
    } else if (detMap.has(i)) {
      detRes = { ...detMap.get(i)! };
    } else {
      detRes = {
        index: i,
        type: spec.type,
        ok: false,
        errored: true,
        message: "Missing deterministic evaluation result",
      };
    }

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

  // 4. Determine overall status SOLELY from the complete assertionResults set
  let finalStatus: "passed" | "failed" | "errored";

  if (assertions.length === 0) {
    // CONTRACT: Valid empty assertions represent smoke tests (e.g. tool execution verification).
    // If unknown indices were passed into a smoke test case, treat as errored.
    if (unknownDetIndices.length > 0 || unknownLlmIndices.length > 0) {
      finalStatus = "errored";
    } else {
      finalStatus = "passed";
    }
  } else {
    const hasUnknown = unknownDetIndices.length > 0 || unknownLlmIndices.length > 0;
    const hasErrored = hasUnknown || assertionResults.some((r) => r.errored);
    const hasFailed = assertionResults.some((r) => !r.ok && !r.skipped && !r.errored);

    if (hasErrored) {
      finalStatus = "errored";
    } else if (hasFailed) {
      finalStatus = "failed";
    } else {
      // All executed non-skipped assertions passed
      if (recordedLlmScores.length > 0) {
        const minScore = Math.min(...recordedLlmScores);
        finalStatus = minScore >= threshold ? "passed" : "failed";
      } else {
        // Pure deterministic test suite, and all passed
        finalStatus = "passed";
      }
    }
  }

  const minLlmScore = recordedLlmScores.length > 0 ? Math.min(...recordedLlmScores) : undefined;

  let feedback = evaluatorFeedback;
  if (!feedback) {
    const hasUnknown = unknownDetIndices.length > 0 || unknownLlmIndices.length > 0;
    if (hasUnknown) {
      feedback = "Received results for unknown or invalid assertion indices.";
    } else if (anyDeterministicFailed) {
      feedback = "Deterministic assertion checks failed. LLM evaluation skipped.";
    } else if (anyDeterministicError) {
      feedback = "One or more deterministic assertions errored during execution.";
    } else if (!evaluatorConfigured && assertions.some((s) => s.type === "llm_dim" || s.type === "llm_custom")) {
      feedback = "Case contains LLM assertions but no evaluator agent is configured.";
    } else if (finalStatus === "errored") {
      feedback = "One or more assertions errored during evaluation.";
    } else if (finalStatus === "passed") {
      feedback = assertions.length === 0
        ? "Smoke test passed (no assertions declared)."
        : "All assertion criteria satisfied.";
    } else if (finalStatus === "failed") {
      feedback = minLlmScore !== undefined
        ? `Evaluation failed to meet threshold of ${threshold}. Min score: ${minLlmScore}.`
        : "One or more assertions failed.";
    }
  }

  return {
    status: finalStatus,
    assertionResults,
    feedback,
    minLlmScore,
  };
}
