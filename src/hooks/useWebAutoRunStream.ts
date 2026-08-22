"use client";

/**
 * useWebAutoRunStream — live-feed for one in-flight Web Auto suite run.
 * Subscribes to `/api/runs/stream`, filters on `kind === "web_auto"`,
 * and accumulates case-level outcomes into a Map keyed by `web_auto_case.id`.
 *
 * Mirrors `useVerificationRunStream` and `useEvaluationRunStream`.
 *
 * @see docs/web-auto.md
 */

import { useEffect, useMemo, useState } from "react";
import type { ErrorEnvelope } from "@/lib/verification/types";

/** Per-case live snapshot accumulated from `case_finished` frames. */
export interface WebAutoCaseLive {
  caseId: string;
  status: "passed" | "failed" | "errored";
  durationMs: number;
  error?: ErrorEnvelope;
}

export interface WebAutoRunLiveState {
  /** runId we are following */
  runId: string | null;
  /** Run-level lifecycle. `idle` = no run currently followed. */
  phase: "idle" | "running" | "passed" | "failed" | "errored";
  /** Per-case results, keyed by `web_auto_case.id` (UUID string). */
  caseResults: Map<string, WebAutoCaseLive>;
  /** Final aggregate counts — only meaningful once `phase !== "running"`. */
  totals?: {
    totalCount: number;
    passedCount: number;
    failedCount: number;
    erroredCount: number;
  };
}

export const IDLE_WEB_AUTO_RUN_STATE: WebAutoRunLiveState = {
  runId: null,
  phase: "idle",
  caseResults: new Map(),
};

export interface WebAutoFrame {
  topic: "web_auto_run";
  kind: string;
  runId: string;
  [key: string]: unknown;
}

export interface WebAutoRunEnvelope {
  kind: "web_auto";
  ownerId: string;
  frame: WebAutoFrame;
}

export function isWebAutoEnvelope(value: unknown): value is WebAutoRunEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "web_auto"
  );
}

export function applyWebAutoFrame(
  base: WebAutoRunLiveState,
  frame: WebAutoFrame,
): WebAutoRunLiveState {
  if (frame.kind === "run_started") {
    return {
      runId: frame.runId,
      phase: "running",
      caseResults: new Map(),
    };
  }

  if (frame.kind === "case_finished") {
    const nextResults = new Map(base.caseResults);
    const caseId = frame.caseId as string;
    nextResults.set(caseId, {
      caseId,
      status: frame.status as WebAutoCaseLive["status"],
      durationMs: (frame.durationMs as number) ?? 0,
      error: frame.error as ErrorEnvelope | undefined,
    });
    return { ...base, caseResults: nextResults };
  }

  if (frame.kind === "run_finished") {
    const status = frame.status as WebAutoRunLiveState["phase"];
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
  }

  return base;
}

/**
 * Subscribe to live frames for the given Web Auto `runId`.
 * Pass `null` to detach the listener.
 */
export function useWebAutoRunStream(
  runId: string | null,
): WebAutoRunLiveState {
  const [snapshot, setSnapshot] = useState<WebAutoRunLiveState | null>(null);

  useEffect(() => {
    if (!runId) return;

    const es = new EventSource("/api/runs/stream");

    const handleFrame = (frame: WebAutoFrame): void => {
      if (frame.runId !== runId) return;

      setSnapshot((prev) => {
        const base: WebAutoRunLiveState =
          prev && prev.runId === runId
            ? prev
            : { runId, phase: "running", caseResults: new Map() };
        return applyWebAutoFrame(base, frame);
      });
    };

    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (isWebAutoEnvelope(parsed)) handleFrame(parsed.frame);
      } catch (err) {
        console.error("[web_auto SSE] parse failed", err);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects.
    };

    return () => {
      es.close();
    };
  }, [runId]);

  return useMemo<WebAutoRunLiveState>(() => {
    if (!runId) return IDLE_WEB_AUTO_RUN_STATE;
    if (!snapshot || snapshot.runId !== runId) {
      return { runId, phase: "running", caseResults: new Map() };
    }
    return snapshot;
  }, [runId, snapshot]);
}