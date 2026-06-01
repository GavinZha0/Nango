"use client";

/**
 * useRunSnapshot — fetch a finished verification run's header + every
 * persisted case result via `GET /api/verification-runs/[id]`.
 *
 * Powers two consumer scenarios in `VerificationSuiteEditor`:
 *   1. The "just-completed" view — after the live SSE stream reaches
 *      a terminal phase, we fetch the snapshot for that runId so the
 *      CaseTree badges stay populated AND `CaseInspector` can show
 *      the persisted `result_payload` / `assertion_results` / `error`
 *      (those don't ride the SSE channel — only lightweight per-case
 *      status / duration frames do).
 *   2. The "history view" — when the user clicks a chip in
 *      `RecentRunsBanner`, the same shape feeds the same UI; the
 *      editor toggles into read-only mode.
 *
 * Pass `null` to detach (no fetch, no state). Each new runId resets
 * the snapshot so consumers never observe a stale row from a prior
 * fetch while loading.
 *
 * @see docs/verification.md — banner / live-feed integration.
 */

import { useCallback, useEffect, useState } from "react";

import type {
  VerificationCaseResultEntity,
  VerificationRunEntity,
} from "@/lib/db/schema";

/** Wire shape of `GET /api/verification-runs/[id]`. */
export interface RunSnapshot {
  run: VerificationRunEntity;
  results: VerificationCaseResultEntity[];
}

export interface UseRunSnapshotResult {
  /** Loaded snapshot for the requested runId, or null when detached
   *  / loading the first time / on fetch error. */
  snapshot: RunSnapshot | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hoisted out of the hook so the setState callsites aren't visible
 * to the `react-hooks/set-state-in-effect` reachability analysis —
 * mirrors the pattern used by `RecentRunsBanner.useRecentRuns`.
 */
async function fetchSnapshot(runId: string): Promise<RunSnapshot> {
  const res = await fetch(`/api/verification-runs/${runId}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RunSnapshot;
}

export function useRunSnapshot(runId: string | null): UseRunSnapshotResult {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
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
    // CONTRACT: reset stale snapshot so consumers never observe a
    // prior run's results while the new one is loading.
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

  // Canonical "fetch on dep change" — see the same suppress comment
  // in `RecentRunsBanner.useRecentRuns` for the rationale.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => refresh(), [refresh]);

  return { snapshot, loading, error };
}
