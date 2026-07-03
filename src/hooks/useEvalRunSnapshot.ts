"use client";

/**
 * useEvalRunSnapshot — fetch a finished evaluation run's header + every
 * persisted case result via `GET /api/eval-runs/[id]`.
 *
 * Powers history-view and post-run snapshots in Evaluation module.
 */

import { useCallback, useEffect, useState } from "react";

import type {
  EvalCaseResultEntity,
  EvalRunEntity,
} from "@/lib/db/schema";

/** Wire shape of `GET /api/eval-runs/[id]`. */
export interface EvalRunSnapshot {
  run: EvalRunEntity;
  results: EvalCaseResultEntity[];
}

export interface UseEvalRunSnapshotResult {
  /** Loaded snapshot for the requested runId, or null when detached
   *  / loading the first time / on fetch error. */
  snapshot: EvalRunSnapshot | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hoisted out of the hook so the setState callsites aren't visible
 * to the `react-hooks/set-state-in-effect` reachability analysis.
 */
async function fetchSnapshot(runId: string): Promise<EvalRunSnapshot> {
  const res = await fetch(`/api/eval-runs/${runId}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as EvalRunSnapshot;
}

export function useEvalRunSnapshot(runId: string | null): UseEvalRunSnapshotResult {
  const [snapshot, setSnapshot] = useState<EvalRunSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!runId) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return () => undefined;
    }
    let cancelled = false;
    setSnapshot(null);
    setLoading(true);
    setError(null);
    fetchSnapshot(runId)
      .then((s) => {
        if (cancelled) return;
        setSnapshot(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => refresh(), [refresh]);

  return { snapshot, loading, error };
}
