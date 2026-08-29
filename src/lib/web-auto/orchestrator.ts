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
import { runWebAutoMcp } from "./runner-mcp";
import { runDeterministicAssertions, extractExpectationAssertions } from "./assertions";
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

// ─── Single case execution ─────────────────────────────────────────────

/**
 * Execute a single Web Auto case end-to-end.
 * NEVER throws — every error surface is mapped into the structured outcome.
 */
export async function runWebAutoCase(
  input: RunWebAutoCaseInput,
): Promise<WebAutoExecutionOutcome> {
  const startedAt: number = Date.now();

  // Step 1: MCP execution (Playwright script)
  const rawInput = (input.case.input ?? {}) as Record<string, unknown>;
  const scriptContent = typeof rawInput.script === "string" ? rawInput.script : null;
  if (!scriptContent) {
    return {
      status: "errored",
      executionOutput: null,
      outputTruncated: false,
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
    return {
      status: "errored",
      executionOutput: null,
      outputTruncated: false,
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

  const suiteVariables = (input.suite.variables ?? undefined) as
    | Record<string, unknown>
    | undefined;

  const mcpResult = await runWebAutoMcp({
    mcpServerId: input.suite.mcpServerId,
    scriptContent,
    variables: suiteVariables,
  });

  if (mcpResult.status === "errored") {
    return {
      status: "errored",
      executionOutput: mcpResult.executionOutput,
      outputTruncated: false,
      verdict: {
        deterministic: { passed: false, results: [] },
        overall: { passed: false, reason: "MCP execution failed" },
      },
      error: mcpResult.error,
      startedAt,
      durationMs: mcpResult.durationMs,
    };
  }

  if (mcpResult.status === "failed") {
    return {
      status: "failed",
      executionOutput: mcpResult.executionOutput,
      outputTruncated: false,
      verdict: {
        deterministic: { passed: false, results: [] },
        overall: { passed: false, reason: "Playwright execution returned error" },
      },
      error: mcpResult.error,
      startedAt,
      durationMs: mcpResult.durationMs,
    };
  }

  // Step 2: Deterministic assertions
  const assertions = input.case.assertions as readonly import("./types").WebAutoAssertionSpec[];
  const deterministicResult = runDeterministicAssertions(
    mcpResult.executionOutput,
    assertions,
    suiteVariables,
  );

  // Step 3: LLM evaluation (if configured and expectations exist)
  let llmResult: {
    passed: boolean;
    score?: number;
    feedback?: string;
    expectationResults: Array<{
      expectation: string;
      score: number;
      feedback: string;
    }>;
  } | null = null;

  if (input.suite.evaluatorAgentId) {
    const expectations = extractExpectationAssertions(assertions);
    if (expectations.length > 0) {
      try {
        const evalResult = await runWebAutoEvaluation({
          evaluatorAgentId: input.suite.evaluatorAgentId,
          executionOutput: mcpResult.executionOutput,
          expectations,
          ownerId: input.ownerId,
        });
        llmResult = {
          passed: evalResult.passed,
          score: evalResult.score,
          feedback: evalResult.feedback,
          expectationResults: evalResult.expectationResults,
        };
      } catch (err) {
        log.error(
          { event: "web_auto_llm_evaluation_failed", err },
          "LLM evaluation failed",
        );
        // LLM evaluation failure doesn't fail the whole case - we log it and continue
        llmResult = {
          passed: false,
          score: 0,
          feedback: "LLM evaluation failed",
          expectationResults: expectations.map((exp) => ({
            expectation: exp.expectation,
            score: 0,
            feedback: "LLM evaluation failed",
          })),
        };
      }
    }
  }

  // Step 4: Merge results
  const verdict: WebAutoVerdict = {
    deterministic: {
      passed: deterministicResult.passed,
      results: deterministicResult.results,
    },
    llm: llmResult
      ? {
          passed: llmResult.passed,
          score: llmResult.score,
          feedback: llmResult.feedback,
          expectationResults: llmResult.expectationResults,
        }
      : undefined,
    overall: {
      passed: deterministicResult.passed && (llmResult ? llmResult.passed : true),
      reason: buildOverallReason(deterministicResult.passed, llmResult?.passed),
    },
  };

  const overallStatus = verdict.overall.passed ? "passed" : "failed";

  return {
    status: overallStatus,
    executionOutput: mcpResult.executionOutput,
    outputTruncated: false,
    verdict,
    error: null,
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

function buildOverallReason(
  deterministicPassed: boolean,
  llmPassed?: boolean,
): string {
  if (deterministicPassed && (llmPassed === undefined || llmPassed)) {
    return "All assertions passed";
  }
  if (!deterministicPassed) {
    return "Deterministic assertions failed";
  }
  if (llmPassed === false) {
    return "LLM evaluation failed";
  }
  return "Mixed assertion results";
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

    // Execute case
    const outcome = await runWebAutoCase({
      caseId: c.id,
      suiteId: input.suiteId,
      suite: input.suite,
      case: c,
      ownerId: input.ownerId,
    });

    // Persist result
    await storage.writeWebAutoCaseResult({
      runId: input.runId,
      caseId: c.id,
      status: outcome.status,
      executionOutput: outcome.executionOutput,
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
    verdict: {
      deterministic: { passed: false, results: [] },
      overall: { passed: false, reason: args.error.message },
    },
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
