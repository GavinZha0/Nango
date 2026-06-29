"use client";

/**
 * useEvaluationRunStream — live-feed for one in-flight evaluation
 * suite or case run. Subscribes to `/api/runs/stream`, filters on
 * `kind === "evaluation"`, and accumulates case-level results.
 *
 * Mirrors `useVerificationRunStream` — see that hook for design
 * rationale (separate EventSource, bounded lifetime, etc.).
 */

import { useEffect, useMemo, useState } from "react";

/** Per-case live result accumulated from `case_completed` frames. */
export interface EvalCaseLive {
  caseId: number;
  caseName: string;
  status: "passed" | "failed" | "errored";
  score: number | null;
  dimensionScores?: Record<string, number>;
  criteriaScore?: number | null;
  criteriaResults?: unknown[];
  feedback?: string | null;
}

export interface EvaluationRunLiveState {
  runId: string | null;
  phase: "idle" | "running" | "passed" | "failed" | "errored";
  caseResults: Map<number, EvalCaseLive>;
  totals?: {
    totalCount: number;
    passedCount: number;
    failedCount: number;
    erroredCount: number;
  };
}

const IDLE: EvaluationRunLiveState = {
  runId: null,
  phase: "idle",
  caseResults: new Map(),
};

interface EvalFrame {
  topic: "evaluation_run";
  kind: string;
  runId: string;
  [key: string]: unknown;
}

interface EvaluationRunEnvelope {
  kind: "evaluation";
  ownerId: string;
  frame: EvalFrame;
}

function isEvaluationEnvelope(
  value: unknown,
): value is EvaluationRunEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "evaluation"
  );
}

/**
 * Subscribe to live frames for the given `runId`. Pass `null` to
 * detach. CONTRACT: re-mounting with a new runId resets state.
 */
export function useEvaluationRunStream(
  runId: string | null,
): EvaluationRunLiveState {
  const [snapshot, setSnapshot] = useState<EvaluationRunLiveState | null>(null);

  useEffect(() => {
    if (!runId) return;

    const es = new EventSource("/api/runs/stream");

    const handleFrame = (frame: EvalFrame): void => {
      if (frame.runId !== runId) return;

      if (frame.kind === "run_started") {
        setSnapshot({
          runId,
          phase: "running",
          caseResults: new Map(),
        });
        return;
      }

      if (frame.kind === "case_completed") {
        setSnapshot((prev) => {
          const base: EvaluationRunLiveState =
            prev && prev.runId === runId
              ? prev
              : { runId, phase: "running", caseResults: new Map() };
          const next = new Map(base.caseResults);
          const caseId = frame.caseId as number;
          next.set(caseId, {
            caseId,
            caseName: (frame.caseName as string) ?? `Case ${caseId}`,
            status: frame.status as EvalCaseLive["status"],
            score: (frame.score as number) ?? null,
            dimensionScores: frame.dimensionScores as Record<string, number>,
            criteriaScore: (frame.criteriaScore as number) ?? null,
            criteriaResults: frame.criteriaResults as unknown[],
            feedback: (frame.feedback as string) ?? null,
          });
          return { ...base, caseResults: next };
        });
        return;
      }

      if (frame.kind === "run_finished") {
        setSnapshot((prev) => {
          const base: EvaluationRunLiveState =
            prev && prev.runId === runId
              ? prev
              : { runId, phase: "running", caseResults: new Map() };
          const status = frame.status as EvaluationRunLiveState["phase"];
          return {
            ...base,
            phase: status === "idle" ? "errored" : status,
            totals: {
              totalCount: (frame.totalCount as number) ?? 0,
              passedCount: (frame.passedCount as number) ?? 0,
              failedCount: (frame.failedCount as number) ?? 0,
              erroredCount: (frame.erroredCount as number) ?? 0,
            },
          };
        });
        return;
      }
    };

    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (isEvaluationEnvelope(parsed)) handleFrame(parsed.frame);
      } catch (err) {
        console.error("[evaluation SSE] parse failed", err);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects.
    };

    return () => {
      es.close();
    };
  }, [runId]);

  return useMemo<EvaluationRunLiveState>(() => {
    if (!runId) return IDLE;
    if (!snapshot || snapshot.runId !== runId) {
      return { runId, phase: "running", caseResults: new Map() };
    }
    return snapshot;
  }, [runId, snapshot]);
}
