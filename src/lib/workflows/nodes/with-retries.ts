/**
 * Retry-loop wrapper shared by the node executors.
 *
 * Owns per-node event emission (`workflow_node_attempt_started` /
 * `_failed` / `_completed`) so per-bucket executors only have to
 * write the *attempt body* — ref resolution, dispatch, output
 * coercion.
 *
 * Retry policy lives on the canonical node (`node.retries`, defaults
 * to `{ attempts: 0 }` ⇒ single try):
 *   - `attempts = N` → at most N RETRIES after the first failure
 *     (N+1 total tries).
 *   - `delaySeconds = K` → wait K seconds between attempts.
 *   - `backoff = "exponential"` → wait `K * 2^attempt` seconds.
 *
 * Every failure is retried per the policy — a per-error-code filter
 * is not currently supported.
 *
 * Abort semantics: if `state.abortSignal` is aborted at any retry
 * boundary, throw WORKFLOW_TIMEOUT without dispatching another
 * attempt. Sleeps between attempts are abort-aware.
 */

import { WorkflowError } from "../error";
import type { Retries } from "../spec/schema";
import type { ExecutionState } from "../engine/execution-context";
import type { WorkflowEngineDependencies } from "../engine";

export interface WithRetriesParams {
  node: { id: number; retries?: Retries };
  /** Read-only node label for events / wrapped errors. */
  nodeName: string;
  state: ExecutionState;
  /** Sub-set of engine deps used by the wrapper. */
  deps: Pick<WorkflowEngineDependencies, "emitEvent">;
  /**
   * The per-attempt body — pure data in / data out. Throws on
   * failure; the wrapper translates throwables via `wrapError`.
   */
  attemptFn: () => Promise<Record<string, unknown>>;
  /**
   * Convert a raw throwable into the bucket-specific WorkflowError
   * envelope (TOOL_EXECUTION_FAILED for tool nodes, etc.). Passing
   * an existing WorkflowError through is the caller's responsibility.
   */
  wrapError: (err: unknown) => WorkflowError;
}

/**
 * Run `attemptFn` with the node's configured retry policy. Returns
 * the successful attempt's outputs; throws the final `WorkflowError`
 * if all attempts fail.
 */
export async function withRetries(
  params: WithRetriesParams,
): Promise<Record<string, unknown>> {
  const { node, nodeName, state, deps, attemptFn, wrapError } = params;
  const policy = node.retries ?? FALLBACK_POLICY;
  let attempt = 0;

  while (true) {
    if (state.abortSignal.aborted) {
      throw new WorkflowError({
        errorCode: "WORKFLOW_TIMEOUT",
        message: `Node ${node.id} ('${nodeName}'): workflow was aborted before this attempt could start.`,
        nodeId: node.id,
        nodeName,
      });
    }

    const startedAt = Date.now();
    deps.emitEvent({
      type: "workflow_node_attempt_started",
      runId: state.runId,
      nodeId: node.id,
      attempt,
    });

    try {
      const outputs = await attemptFn();
      deps.emitEvent({
        type: "workflow_node_completed",
        runId: state.runId,
        nodeId: node.id,
        attempt,
        durationMs: Date.now() - startedAt,
        outputs,
      });
      return outputs;
    } catch (err) {
      const wfErr = wrapError(err);
      deps.emitEvent({
        type: "workflow_node_attempt_failed",
        runId: state.runId,
        nodeId: node.id,
        attempt,
        errorCode: wfErr.errorCode,
        message: wfErr.message,
      });
      if (attempt >= policy.attempts) throw wfErr;

      const delayMs = computeBackoffMs(
        policy.delay_seconds * 1000,
        policy.backoff,
        attempt,
      );
      await abortableSleep(delayMs, state.abortSignal);
      attempt += 1;
    }
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

const FALLBACK_POLICY: Retries = {
  attempts: 0,
  delay_seconds: 0,
};

function computeBackoffMs(
  baseMs: number,
  backoff: Retries["backoff"],
  attempt: number,
): number {
  if (baseMs <= 0) return 0;
  if (backoff === "exponential") return baseMs * 2 ** attempt;
  return baseMs;
}

/**
 * Promise-based sleep that resolves early when `signal` fires. The
 * next loop iteration re-checks the signal and throws
 * WORKFLOW_TIMEOUT — this helper does NOT throw on its own.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
