"use client";

/**
 * useVerificationRunStream — live-feed for one in-flight verification
 * suite run. Subscribes to the same SSE endpoint that backs
 * notifications (`/api/runs/stream`), filters on `topic ===
 * "verification_run"`, and accumulates case-level outcomes into a Map
 * keyed by `verification_case.id`.
 *
 * @see docs/verification.md — frame shapes + multiplexing rules.
 *
 * Why a SEPARATE EventSource (rather than piggybacking the
 * notifications hook):
 *   - the editor is the only place that cares about case-level frames;
 *     widening the notifications store to carry them would force every
 *     other hook to ignore them on every fan-out;
 *   - the editor mounts/unmounts as the user navigates between suites,
 *     so the connection lifetime is naturally bounded.
 *
 * The cost is one extra long-lived HTTP connection while the editor
 * page is open. The runner event-bus is in-process pub/sub so the
 * server-side fan-out is free.
 */

import { useEffect, useMemo, useState } from "react";

import type {
  VerificationCaseFinishedFrame,
  VerificationFrame,
  VerificationRunFinishedFrame,
} from "@/lib/verification/types";

/** Per-case latest snapshot accumulated from `case_finished` frames. */
export interface RunCaseLive {
  status: VerificationCaseFinishedFrame["status"];
  durationMs: number;
  error?: VerificationCaseFinishedFrame["error"];
}

export interface VerificationRunLiveState {
  /** runId we are following — surfaced for downstream guards. */
  runId: string | null;
  /** Run-level lifecycle. `idle` = no run currently followed. */
  phase:
    | "idle"
    | "running"
    | "passed"
    | "failed"
    | "errored"
    | "timeout";
  /** Per-case results, keyed by `verification_case.id` (bigint as number). */
  caseResults: Map<number, RunCaseLive>;
  /** Final aggregate counts — only meaningful once `phase !== "running"`. */
  totals?: {
    totalCount: number;
    passedCount: number;
    failedCount: number;
    erroredCount: number;
    skippedCount: number;
  };
}

const IDLE: VerificationRunLiveState = {
  runId: null,
  phase: "idle",
  caseResults: new Map(),
};

/**
 * Wire envelope shape published by `publishVerificationFrame` and
 * serialised verbatim by `/api/runs/stream`. The inner `frame` is what
 * carries the `topic: "verification_run"` discriminator — the OUTER
 * `kind` is the multiplex tag used to share the channel with
 * `notification` and `run_finalized` events.
 *
 * Bug fix: the previous guard checked `topic` at the outer level,
 * which is `undefined`, so every verification frame was silently
 * dropped and the UI stayed pinned to the optimistic "running" stub.
 * See docs/verification.md.
 */
interface VerificationRunEnvelope {
  kind: "verification";
  ownerId: string;
  frame: VerificationFrame;
}

function isVerificationEnvelope(
  value: unknown,
): value is VerificationRunEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "verification"
  );
}

function phaseFromRunFinished(
  frame: VerificationRunFinishedFrame,
): VerificationRunLiveState["phase"] {
  // verification_run.status maps 1:1 to the phase enum here.
  return frame.status;
}

/**
 * Subscribe to live frames for the given `runId`. Pass `null` to
 * detach the listener (e.g. when leaving history-view mode).
 *
 * CONTRACT: re-mounting with a NEW runId resets the accumulator.
 * The hook does NOT bootstrap from DB — for completed runs, fetch
 * `/api/verification-runs/[id]` instead.
 */
export function useVerificationRunStream(
  runId: string | null,
): VerificationRunLiveState {
  // The snapshot is tagged with the runId it describes. When the
  // consumer asks about a DIFFERENT runId, we deliver a fresh
  // "running" sentinel from render-time derivation below — we
  // do NOT pre-empt by setState'ing inside the effect body, which
  // React 19's strict lint forbids. setState only happens inside
  // the SSE message handler (an event callback), which is allowed.
  const [snapshot, setSnapshot] = useState<VerificationRunLiveState | null>(
    null,
  );

  useEffect(() => {
    if (!runId) return;

    const es = new EventSource("/api/runs/stream");

    const handleFrame = (frame: VerificationFrame): void => {
      // The server publishes every run on the owner's channel; filter
      // on the runId WE were told to follow. Closures over `runId`,
      // not a ref — the effect closes over the current value.
      if (frame.runId !== runId) return;

      if (frame.kind === "run_started") {
        setSnapshot({
          runId,
          phase: "running",
          caseResults: new Map(),
        });
        return;
      }

      if (frame.kind === "case_finished") {
        setSnapshot((prev) => {
          const base: VerificationRunLiveState =
            prev && prev.runId === runId
              ? prev
              : { runId, phase: "running", caseResults: new Map() };
          const nextResults = new Map(base.caseResults);
          nextResults.set(frame.caseId, {
            status: frame.status,
            durationMs: frame.durationMs,
            error: frame.error,
          });
          return { ...base, caseResults: nextResults };
        });
        return;
      }

      // run_finished
      setSnapshot((prev) => {
        const base: VerificationRunLiveState =
          prev && prev.runId === runId
            ? prev
            : { runId, phase: "running", caseResults: new Map() };
        return {
          ...base,
          phase: phaseFromRunFinished(frame),
          totals: {
            totalCount: frame.totalCount,
            passedCount: frame.passedCount,
            failedCount: frame.failedCount,
            erroredCount: frame.erroredCount,
            skippedCount: frame.skippedCount,
          },
        };
      });
    };

    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (isVerificationEnvelope(parsed)) handleFrame(parsed.frame);
      } catch (err) {
        console.error("[verification SSE] parse failed", err);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do beyond logging.
      // Final state surfaces via the eventual `run_finished` frame
      // (or, if the server died, the recovery sweep at boot).
    };

    return () => {
      es.close();
    };
  }, [runId]);

  // Render-time derivation. Two cases:
  //   - runId is null               → expose IDLE.
  //   - runId mismatches snapshot   → expose a fresh "running" stub
  //                                   memoised on runId so downstream
  //                                   `useMemo([caseResults])` is stable.
  //   - runId matches               → expose the live snapshot.
  return useMemo<VerificationRunLiveState>(() => {
    if (!runId) return IDLE;
    if (!snapshot || snapshot.runId !== runId) {
      return { runId, phase: "running", caseResults: new Map() };
    }
    return snapshot;
  }, [runId, snapshot]);
}
