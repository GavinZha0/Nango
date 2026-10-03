/**
 * Web Auto — suite/case execution orchestrator.
 *
 * Coordinates the hybrid execution engine:
 * 1. MCP execution (Playwright via browser_run_code_unsafe)
 * 2. Deterministic assertions (json_schema, js_expression)
 * 3. LLM evaluation (expectation assertions via evaluator agent)
 *
 * Pattern follows verification's orchestrator but with the dual-layer assertion model.
 * See docs/web-auto.md.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import { publish } from "@/lib/runner/event-bus";
import { recordRunNotification } from "@/lib/runner/notifications";
import {
  evaluateAssertions,
  determineCaseVerdict,
  resolveInput,
} from "@/lib/assertions";
import { registerCaseInSuiteContext } from "@/lib/testing/suite-context";
import { resolveSuiteVariables } from "@/lib/testing/variable-resolver.server";
import { redactSensitiveData, redactErrorEnvelope } from "@/lib/testing/redact";
import { runWebAutoMcp } from "./runner-mcp";
import { runWebAutoEvaluation } from "./evaluator";
import * as storage from "./storage";
import type {
  WebAutoExecutionOutcome,
  WebAutoVerdict,
  ErrorEnvelope,
  RunWebAutoCaseInput,
  WebAutoFrame,
} from "./types";

const log = childLogger({ component: "web-auto-orchestrator" });

function publishWebAutoFrame(ownerId: string, frame: WebAutoFrame): void {
  publish(ownerId, { kind: "web_auto", ownerId, frame });
}

/**
 * Extract structured business output from a Playwright execution output.
 * Unwraps `{ result: ... }` while preserving optional page metadata under `_page`.
 *
 * Page metadata is strictly exposed under `_page` to prevent collision with
 * business payload fields (e.g. pagination `page: 1`).
 */
export function extractWebAutoStructuredData(executionOutput: unknown): unknown {
  if (
    executionOutput &&
    typeof executionOutput === "object" &&
    "result" in executionOutput
  ) {
    const env = executionOutput as { result?: unknown; _page?: unknown };
    if (env.result !== undefined && env.result !== null) {
      if (typeof env.result === "object" && !Array.isArray(env.result) && env._page) {
        return {
          _page: env._page,
          ...(env.result as Record<string, unknown>),
        };
      }
      return env.result;
    }
  }
  return executionOutput ?? {};
}

// ─── Single case execution ─────────────────────────────────────────────

/**
 * Execute a single Web Auto case end-to-end.
 * NEVER throws — every error surface is mapped into the structured outcome.
 */
export async function runWebAutoCase(
  input: RunWebAutoCaseInput,
): Promise<WebAutoExecutionOutcome> {
  const startedAt: number = Date.now();

  const rawInput = (input.case.input ?? {}) as Record<string, unknown>;
  const rawScript = typeof rawInput.script === "string" ? rawInput.script : null;
  if (!rawScript) {
    const errorAssertionResult: import("@/lib/assertions").AssertionResult = {
      index: 0,
      type: "error",
      ok: false,
      errorSource: "internal",
      message: "Case has no script content to execute",
    };
    return {
      status: "errored",
      executionOutput: null,
      outputTruncated: false,
      assertionResults: [errorAssertionResult],
      verdict: {
        deterministic: { passed: false, results: [] },
        overall: { passed: false, reason: "No script content provided" },
      },
      error: {
        source: "internal",
        message: "Case has no script content to execute",
      },
      startedAt,
      durationMs: 0,
    };
  }

  if (!input.suite.mcpServerId) {
    const errorAssertionResult: import("@/lib/assertions").AssertionResult = {
      index: 0,
      type: "error",
      ok: false,
      errorSource: "internal",
      message: "Suite has no MCP server configured for Playwright execution",
    };
    return {
      status: "errored",
      executionOutput: null,
      outputTruncated: false,
      assertionResults: [errorAssertionResult],
      verdict: {
        deterministic: { passed: false, results: [] },
        overall: { passed: false, reason: "Suite has no MCP server configured" },
      },
      error: {
        source: "internal",
        message: "Suite has no MCP server configured for Playwright execution",
      },
      startedAt,
      durationMs: 0,
    };
  }

  // Step 1: Resolve suite variables with credential support.
  // Suite runs pass preResolved to avoid per-case re-resolution (aligns with
  // Verification/Evaluation one-shot pattern). Single-case runs self-resolve.
  const {
    resolved: resolvedVariables,
    literalVariables,
    sensitiveValues,
    error: resolveError,
  } = input.preResolved ?? await resolveSuiteVariables(input.suite.variables ?? {}, {
    allowCredentials: true,
  });

  if (resolveError) {
    const errorAssertionResult: import("@/lib/assertions").AssertionResult = {
      index: 0,
      type: "error",
      ok: false,
      errorSource: resolveError.source ?? "config",
      message: resolveError.message,
    };
    return {
      status: "errored",
      executionOutput: null,
      outputTruncated: false,
      assertionResults: [errorAssertionResult],
      verdict: {
        deterministic: { passed: false, results: [] },
        overall: { passed: false, reason: resolveError.message },
      },
      error: resolveError,
      startedAt,
      durationMs: 0,
    };
  }

  // Step 2: Resolve dynamic generators and cross-case references in input payload
  const contextForResolution = {
    cases: input.suiteContext ?? {},
    variables: resolvedVariables,
    ...resolvedVariables,
  };
  const resolvedInput = resolveInput(rawInput, contextForResolution);
  const effectiveScript =
    typeof resolvedInput.script === "string" ? resolvedInput.script : rawScript;

  // Step 3: Wrap script with IIFE and inject resolved variables and cases
  // QUIRK: JSON.stringify does not escape U+2028/U+2029 which are line
  // terminators in ES5 string literals — raw embedding would SyntaxError.
  const safeJson = JSON.stringify(resolvedVariables)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const safeCasesJson = JSON.stringify(input.suiteContext ?? {})
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const scriptWithVariables = `(() => {
  const variables = Object.freeze(${safeJson});
  const cases = Object.freeze(${safeCasesJson});
  return (${effectiveScript.trim()});
})()`;

  // Step 4: MCP execution (Playwright script)
  const effectiveTimeoutSec = input.suite.timeoutSec ?? 60;
  const mcpResult = await runWebAutoMcp({
    mcpServerId: input.suite.mcpServerId,
    scriptContent: scriptWithVariables,
    timeoutSec: effectiveTimeoutSec,
  });

  // ★ Earliest Sanitization ★
  // Immediately mask secrets in output and error envelope BEFORE assertion evaluation
  // and LLM prompt construction to eliminate downstream credential leakage.
  const sanitizedOutput = redactSensitiveData(
    mcpResult.executionOutput,
    sensitiveValues,
  );
  const sanitizedMcpError = redactErrorEnvelope(
    mcpResult.error,
    sensitiveValues,
  );

  const assertions = (input.case.assertions ?? []) as readonly import("@/lib/assertions").AssertionSpec[];

  if (mcpResult.status === "errored") {
    // If the tool timed out and the case specified a duration_s SLA threshold lower
    // than the timeout cap, attribute the failure to the metric assertion instead of infra errored.
    if (sanitizedMcpError?.source === "timeout") {
      const durationAssertion = assertions.find(
        (a) => a.type === "metric" && (a as { metric?: string }).metric === "duration_s",
      ) as { type: "metric"; metric: string; operator: string; threshold: number } | undefined;

      if (
        durationAssertion
        && durationAssertion.operator === "<"
        && effectiveTimeoutSec > durationAssertion.threshold
      ) {
        const metricResult: import("@/lib/assertions").AssertionResult = {
          index: assertions.indexOf(durationAssertion as never),
          type: "metric",
          ok: false,
          expected: `${durationAssertion.operator} ${durationAssertion.threshold}s`,
          actual: `>= ${effectiveTimeoutSec}s (timed out)`,
          message: `Playwright script execution timed out at ${effectiveTimeoutSec}s, exceeding duration threshold of ${durationAssertion.threshold}s`,
        };
        return {
          status: "failed",
          executionOutput: sanitizedOutput,
          outputTruncated: false,
          assertionResults: [metricResult],
          verdict: {
            deterministic: { passed: false, results: [metricResult] },
            overall: {
              passed: false,
              reason: `Execution timed out at ${effectiveTimeoutSec}s, exceeding SLA threshold of ${durationAssertion.threshold}s`,
            },
          },
          error: sanitizedMcpError,
          startedAt,
          durationMs: mcpResult.durationMs,
        };
      }
    }

    const errorAssertionResult: import("@/lib/assertions").AssertionResult = {
      index: 0,
      type: "error",
      ok: false,
      errorSource: sanitizedMcpError?.source ?? "internal",
      message: sanitizedMcpError?.message ?? "MCP execution failed",
    };
    return {
      status: "errored",
      executionOutput: sanitizedOutput,
      outputTruncated: false,
      assertionResults: [errorAssertionResult],
      verdict: {
        deterministic: { passed: false, results: [] },
        overall: { passed: false, reason: "MCP execution failed" },
      },
      error: sanitizedMcpError,
      startedAt,
      durationMs: mcpResult.durationMs,
    };
  }

  if (mcpResult.status === "failed") {
    const errorAssertionResult: import("@/lib/assertions").AssertionResult = {
      index: 0,
      type: "error",
      ok: false,
      errorSource: sanitizedMcpError?.source ?? "tool",
      message: sanitizedMcpError?.message ?? "Playwright execution returned error",
    };
    return {
      status: "failed",
      executionOutput: sanitizedOutput,
      outputTruncated: false,
      assertionResults: [errorAssertionResult],
      verdict: {
        deterministic: { passed: false, results: [] },
        overall: { passed: false, reason: "Playwright execution returned error" },
      },
      error: sanitizedMcpError,
      startedAt,
      durationMs: mcpResult.durationMs,
    };
  }

  // Step 5: Evaluate assertions using universal engine
  // Pass literalVariables ONLY so credentials never leak into assertion error diffs or LLM evaluators
  const outcome = evaluateAssertions(sanitizedOutput, assertions, {
    variables: literalVariables,
    metrics: { durationMs: mcpResult.durationMs },
    runContext: {
      cases: input.suiteContext ?? {},
      isWebAuto: true,
    },
  });

  const deterministicResult = {
    passed: outcome.allDeterministicPassed,
    results: outcome.deterministicResults,
  };

  const llmRequired = outcome.llmAssertions.length > 0;
  const evaluatorAgentId = input.suite.evaluatorAgentId;
  const evaluatorConfigured = evaluatorAgentId !== null;

  // Step 5: LLM evaluation (if configured and expectations exist)
  // Consumes sanitizedOutput to ensure secret values are never sent to external LLM providers
  let llmResult: import("./evaluator").WebAutoEvaluationResult | null = null;

  if (evaluatorAgentId && llmRequired) {
    const expectations = outcome.llmAssertions.map((item) => {
      const customSpec = item.spec.type === "llm_custom" ? item.spec : undefined;
      return {
        expectation: customSpec?.expectation,
        unexpectation: customSpec?.unexpectation,
        reference: customSpec?.reference,
        referenceImage: customSpec?.referenceImage,
        context: customSpec?.context,
      };
    });

    if (expectations.length > 0) {
      try {
        const evalResult = await runWebAutoEvaluation({
          evaluatorAgentId,
          executionOutput: sanitizedOutput,
          expectations,
          ownerId: input.ownerId,
        });
        llmResult = evalResult;
      } catch (err) {
        log.error(
          { event: "web_auto_llm_evaluation_failed", err },
          "LLM evaluation failed",
        );
        llmResult = {
          passed: false,
          score: 1,
          feedback: "LLM evaluation failed",
          expectationResults: expectations.map((exp, idx) => ({
            index: idx,
            score: 1,
            reason: "LLM evaluation failed",
            feedback: "LLM evaluation failed",
            expectation: exp.expectation,
            unexpectation: exp.unexpectation,
            reference: exp.reference,
          })),
        };
      }
    }
  }

  // Step 6: Compute unified verdict and assertionResults
  const sanitizedFeedback = llmResult?.feedback
    ? redactSensitiveData(llmResult.feedback, sensitiveValues)
    : undefined;

  const rawAssertionResults = deterministicResult.results ?? [];
  const sanitizedDeterministicResults = redactSensitiveData(
    rawAssertionResults,
    sensitiveValues,
  );

  const llmScoresForVerdict = llmResult?.expectationResults?.map((r, i) => {
    const originalIndex = outcome.llmAssertions[i]?.index ?? r.index;
    return {
      index: originalIndex,
      score: r.score,
      reason: r.reason ? redactSensitiveData(r.reason, sensitiveValues) : undefined,
    };
  });

  const caseVerdict = determineCaseVerdict({
    assertions,
    deterministicResults: sanitizedDeterministicResults,
    llmScores: llmScoresForVerdict,
    evaluatorConfigured,
    evaluatorError: llmResult?.error?.message,
    threshold: 3,
    evaluatorFeedback: sanitizedFeedback,
  });

  const unifiedAssertionResults = caseVerdict.assertionResults;
  const status = caseVerdict.status;
  const statusReason = caseVerdict.feedback ?? "Execution completed";
  const statusError: ErrorEnvelope | null = status === "errored" ? {
    source: "config",
    message: statusReason,
    details: { missing: "evaluatorAgentId", suiteId: input.suiteId },
  } : null;

  const verdict: WebAutoVerdict = {
    deterministic: {
      passed: deterministicResult.passed,
      results: sanitizedDeterministicResults,
    },
    llm: llmResult
      ? {
          passed: llmResult.passed,
          score: llmResult.score,
          feedback: sanitizedFeedback,
          expectationResults: llmResult.expectationResults.map((r) => ({
            ...r,
            reason: redactSensitiveData(r.reason, sensitiveValues),
            feedback: r.feedback
              ? redactSensitiveData(r.feedback, sensitiveValues)
              : undefined,
          })),
        }
      : undefined,
    overall: {
      passed: status === "passed",
      reason: statusReason,
    },
  };

  // An errored (incomplete) outcome never carries a numeric score: `null` is
  // the honest signal for "no judge result", while 0 would read as a graded
  // failure of the target. Deterministic failures keep the existing 0-score
  // override (they ARE graded failures of the target).
  const finalScore: number | undefined =
    status === "errored"
      ? undefined
      : deterministicResult.passed
        ? (llmResult?.score ?? undefined)
        : 0;

  return {
    status,
    resolvedInput,
    executionOutput: sanitizedOutput,
    outputTruncated: false,
    assertionResults: unifiedAssertionResults,
    score: finalScore,
    feedback: sanitizedFeedback,
    verdict,
    error: statusError,
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

// ─── Suite execution ───────────────────────────────────────────────────

export interface StartWebAutoSuiteRunInput {
  suiteId: string;
  ownerId: string;
}

export interface StartWebAutoSuiteRunResult {
  runId: string;
  totalCount: number;
}

/**
 * Kick off a Web Auto suite run. Returns synchronously with the new
 * web_auto_run id; the actual case loop runs in the background and
 * publishes SSE frames.
 */
export async function startWebAutoSuiteRun(
  input: StartWebAutoSuiteRunInput,
): Promise<StartWebAutoSuiteRunResult> {
  const suite = await storage.getWebAutoSuiteById(input.suiteId);
  if (!suite) throw new Error(`Web Auto suite not found: ${input.suiteId}`);

  const cases = await storage.listEnabledWebAutoCasesForRun(input.suiteId);
  const run = await storage.createWebAutoRun({
    suiteId: input.suiteId,
    status: "running",
    passed: 0,
    failed: 0,
    errored: 0,
    createdBy: input.ownerId,
  });

  publishWebAutoFrame(input.ownerId, {
    topic: "web_auto_run",
    kind: "run_started",
    runId: run.id,
    suiteId: input.suiteId,
    suiteName: suite.name,
    totalCount: cases.length,
  });

  // Empty suite: finalise immediately
  if (cases.length === 0) {
    await storage.finalizeWebAutoRun({
      runId: run.id,
      status: "passed",
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
    });
    publishWebAutoFrame(input.ownerId, {
      topic: "web_auto_run",
      kind: "run_finished",
      runId: run.id,
      suiteId: input.suiteId,
      status: "passed",
      totalCount: 0,
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
    });
    return { runId: run.id, totalCount: 0 };
  }

  // Fire-and-forget background loop
  void executeWebAutoSuiteLoop({
    runId: run.id,
    suiteId: input.suiteId,
    suite,
    cases,
    ownerId: input.ownerId,
  });

  return { runId: run.id, totalCount: cases.length };
}

interface ExecuteWebAutoSuiteLoopInput {
  runId: string;
  suiteId: string;
  suite: import("./storage").WebAutoSuiteEntity;
  cases: Awaited<ReturnType<typeof storage.listEnabledWebAutoCasesForRun>>;
  ownerId: string;
}

interface LoopCounters {
  passedCount: number;
  failedCount: number;
  erroredCount: number;
}

async function executeWebAutoSuiteLoop(
  input: ExecuteWebAutoSuiteLoopInput,
): Promise<void> {
  const counters: LoopCounters = {
    passedCount: 0,
    failedCount: 0,
    erroredCount: 0,
  };

  try {
    await runWebAutoSuiteCases(input, counters);
    await finaliseAndAnnounce(input, counters);
  } catch (err) {
    await handleSuiteLoopCrash(input, counters, err);
  }
}

async function runWebAutoSuiteCases(
  input: ExecuteWebAutoSuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  const suiteStartedAt: number = Date.now();
  const timeoutMs: number = input.suite.timeoutSec * 1000;
  const suiteContext: Record<string, unknown> = {};

  // Resolve suite variables once for the entire suite run (aligns with
  // Verification/Evaluation one-shot pattern). All cases in this run see
  // the same credential snapshot, eliminating N redundant resolutions.
  const preResolved = await resolveSuiteVariables(input.suite.variables ?? {}, {
    allowCredentials: true,
  });

  if (preResolved.error) {
    // All cases fail with the same config error — no MCP calls attempted.
    for (const c of input.cases) {
      await persistAndPublishError({
        ownerId: input.ownerId,
        runId: input.runId,
        caseId: c.id,
        error: preResolved.error,
      });
      counters.erroredCount += 1;
    }
    return;
  }

  for (const c of input.cases) {
    // Wall-clock timeout check
    const elapsed: number = Date.now() - suiteStartedAt;
    if (elapsed > timeoutMs) {
      // Skip remaining cases due to timeout
      await persistAndPublishError({
        ownerId: input.ownerId,
        runId: input.runId,
        caseId: c.id,
        error: {
          source: "timeout",
          message: "Suite timeout exceeded",
          details: { elapsedMs: elapsed },
        },
      });
      counters.erroredCount += 1;
      continue;
    }

    // Execute case with pre-resolved variables and suite context
    const outcome = await runWebAutoCase({
      caseId: c.id,
      suiteId: input.suiteId,
      suite: input.suite,
      case: c,
      ownerId: input.ownerId,
      preResolved,
      suiteContext,
    });

    const outputData = extractWebAutoStructuredData(outcome.executionOutput);
    registerCaseInSuiteContext(suiteContext, c.name, {
      input: outcome.resolvedInput ?? (c.input as Record<string, unknown> ?? {}),
      output: outputData,
    });

    // Persist result
    await storage.writeWebAutoCaseResult({
      runId: input.runId,
      caseId: c.id,
      status: outcome.status,
      executionOutput: outcome.executionOutput,
      assertionResults: outcome.assertionResults,
      score: outcome.score,
      feedback: outcome.feedback,
      verdict: outcome.verdict,
      error: outcome.error,
      startedAt: outcome.startedAt,
      durationMs: outcome.durationMs,
    });

    // Update counters
    if (outcome.status === "passed") counters.passedCount += 1;
    else if (outcome.status === "failed") counters.failedCount += 1;
    else counters.erroredCount += 1;

    publishWebAutoFrame(input.ownerId, {
      topic: "web_auto_run",
      kind: "case_finished",
      runId: input.runId,
      caseId: c.id,
      status: outcome.status,
      durationMs: outcome.durationMs,
      error: outcome.error || undefined,
    });
  }
}

async function finaliseAndAnnounce(
  input: ExecuteWebAutoSuiteLoopInput,
  counters: LoopCounters,
): Promise<void> {
  const overallStatus: "passed" | "failed" | "errored" =
    counters.erroredCount > 0
      ? "errored"
      : counters.failedCount > 0
      ? "failed"
      : "passed";

  await storage.finalizeWebAutoRun({
    runId: input.runId,
    status: overallStatus,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
  });

  publishWebAutoFrame(input.ownerId, {
    topic: "web_auto_run",
    kind: "run_finished",
    runId: input.runId,
    suiteId: input.suiteId,
    status: overallStatus,
    totalCount: input.cases.length,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount,
  });

  // Record notification
  await recordRunNotification({
    ownerId: input.ownerId,
    runId: input.runId,
    kind: overallStatus === "passed" ? "run_completed" : "run_failed",
    title: `Web Auto: ${input.suite.name}`,
    body: `✓ ${counters.passedCount} Passed, ✗ ${counters.failedCount} Failed, ${counters.erroredCount} Errored`,
    sourceLabel: "Web Automation",
    task: `Run web auto suite '${input.suite.name}'`,
    initiator: "web_auto",
  });
}

async function handleSuiteLoopCrash(
  input: ExecuteWebAutoSuiteLoopInput,
  counters: LoopCounters,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log.error(
    { event: "web_auto_suite_loop_crash", runId: input.runId, err: message },
    "Web Auto suite loop crashed",
  );

  await storage.finalizeWebAutoRun({
    runId: input.runId,
    status: "errored",
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount + 1, // Count the crash as an error
  });

  publishWebAutoFrame(input.ownerId, {
    topic: "web_auto_run",
    kind: "run_finished",
    runId: input.runId,
    suiteId: input.suiteId,
    status: "errored",
    totalCount: input.cases.length,
    passedCount: counters.passedCount,
    failedCount: counters.failedCount,
    erroredCount: counters.erroredCount + 1,
  });

  await recordRunNotification({
    ownerId: input.ownerId,
    runId: input.runId,
    kind: "run_failed",
    title: `Web Auto: ${input.suite.name}`,
    body: `Crashed: ${message}`,
    sourceLabel: "Web Automation",
    task: `Run web auto suite '${input.suite.name}'`,
    initiator: "web_auto",
  });
}

async function persistAndPublishError(args: {
  ownerId: string;
  runId: string;
  caseId: number;
  error: ErrorEnvelope;
}): Promise<void> {
  await storage.writeWebAutoCaseResult({
    runId: args.runId,
    caseId: args.caseId,
    status: "errored",
    executionOutput: null,
    // NB: write the real columns directly — the legacy `verdict` shape is
    // only digested by a fallback in writeWebAutoCaseResult and carried no
    // data for an errored case anyway (F17 cleanup).
    assertionResults: [],
    score: null,
    feedback: null,
    error: args.error,
    startedAt: Date.now(),
    durationMs: 0,
  });

  publishWebAutoFrame(args.ownerId, {
    topic: "web_auto_run",
    kind: "case_finished",
    runId: args.runId,
    caseId: args.caseId,
    status: "errored",
    durationMs: 0,
    error: args.error,
  });
}
