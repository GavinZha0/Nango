"use client";

/**
 * RecentRunsBanner — horizontal strip of recent run chips. Rendered
 * inline on the right side of the editor header (next to the suite
 * name). Spec: docs/verification.md.
 *
 * Layout-wise the banner is **chrome-less** — no border, no bg, no
 * padding — so the consumer decides where it sits. The chevron + chip
 * cluster sizes to its content; cap its parent width if it must share
 * a row with a flexible-width sibling.
 *
 * Pagination model: server returns runs DESC by `started_at`; we show
 * `limit` (5) chips at a time and walk backward in time via the `Prev`
 * arrow on the LEFT (older) and forward via the `Next` arrow on the
 * RIGHT (newer). Numbering is relative to the visible page so the
 * newest in the window is always labelled `#5` (matches the mock-up).
 *
 * Live-run integration:
 *   - When the parent has an active run (`liveRunId`, `livePhase`),
 *     the banner injects a transient leading chip so users see
 *     real-time activity without refetching every frame.
 *   - On run completion the parent bumps `refreshKey`; the banner
 *     refetches and the persisted chip replaces the transient one.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { formatTimestamp } from "@/components/admin/format";

const LIMIT = 5;

// --- Row type ----------------------------------------------------------------

/** Matches the JSON shape of `VerificationRunEntity` / `EvalRunEntity` over the wire. */
export interface BannerRun {
  id: string;
  status: "running" | "passed" | "failed" | "errored" | "timeout";
  totalCount: number;
  passedCount: number;
  failedCount: number;
  erroredCount: number;
  skippedCount?: number;
  startedAt: string;
  finishedAt: string | null;
}

// --- Status presentation -----------------------------------------------------

interface StatusVisual {
  icon: ReactNode;
  /** Tailwind class for the chip border ring (status-tinted). */
  ring: string;
  /** Tailwind class for the chip background fill — kept very faint
   *  (status-tinted at low opacity) so adjacent chips read as
   *  distinct items without competing with the page chrome. */
  bg: string;
}

function statusVisual(status: BannerRun["status"]): StatusVisual {
  switch (status) {
    case "running":
      return {
        icon: <Loader2 className="h-3 w-3 animate-spin text-sky-500" />,
        ring: "ring-sky-500/30",
        bg: "bg-sky-500/10",
      };
    case "passed":
      return {
        icon: <CircleCheck className="h-3 w-3 text-emerald-500" />,
        ring: "ring-emerald-500/30",
        bg: "bg-emerald-500/10",
      };
    case "failed":
      return {
        icon: <CircleX className="h-3 w-3 text-red-500" />,
        ring: "ring-red-500/30",
        bg: "bg-red-500/10",
      };
    case "errored":
      return {
        icon: <CircleAlert className="h-3 w-3 text-amber-500" />,
        ring: "ring-amber-500/30",
        bg: "bg-amber-500/10",
      };
    case "timeout":
      return {
        icon: <Clock className="h-3 w-3 text-amber-500" />,
        ring: "ring-amber-500/30",
        bg: "bg-amber-500/10",
      };
  }
}

// --- Hook for fetching one page --------------------------------------------

interface UseRecentRunsResult {
  rows: BannerRun[];
  /** Absolute count of runs for the suite. Drives chip labels and
   *  the older-page enable check; defaults to 0 until the first
   *  fetch resolves. */
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Wire shape of `GET /api/verification-suites/[id]/runs` / `GET /api/eval-suites/[id]/runs`. */
interface RunsPageResponse {
  rows: BannerRun[];
  total: number;
}

/**
 * Hoisted out of the hook so its setState callsites are not visible
 * to the `react-hooks/set-state-in-effect` linter's reachability
 * analysis — this is the canonical "fetch on dep change" pattern,
 * and the lint mis-flags it when the fetcher is defined locally.
 */
async function fetchRecentRuns(
  apiPrefix: "verification-suites" | "eval-suites",
  suiteId: string,
  offset: number,
): Promise<RunsPageResponse> {
  const url = `/api/${apiPrefix}/${suiteId}/runs?offset=${offset}&limit=${LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RunsPageResponse;
}

function useRecentRuns(
  apiPrefix: "verification-suites" | "eval-suites",
  suiteId: string,
  offset: number,
  refreshKey: number,
): UseRecentRunsResult {
  const [rows, setRows] = useState<BannerRun[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRecentRuns(apiPrefix, suiteId, offset)
      .then((json) => {
        if (cancelled) return;
        setRows(json.rows);
        setTotal(json.total);
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
  }, [apiPrefix, suiteId, offset]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => refresh(), [refresh, refreshKey]);

  return { rows, total, loading, error, refresh: () => void refresh() };
}

// --- Component --------------------------------------------------------------

export interface RecentRunsBannerProps {
  suiteId: string;
  /** Bump to force a refetch (e.g. when a run completes). */
  refreshKey: number;
  /** ID of the currently-followed run (null = no live run). */
  liveRunId: string | null;
  /** Phase of the live run; used to render a leading chip with a spinner. */
  livePhase: BannerRun["status"] | null;
  /** Run currently being viewed in history mode (null = live editor). */
  selectedRunId: string | null;
  /** Toggle history-view selection. `seq` is the absolute run
   *  sequence number of the clicked chip (1-indexed, oldest = #1)
   *  — the editor surfaces it in the CaseInspector toolbar so the
   *  user can tell at a glance which run they're inspecting. `null`
   *  payload means "deselect, return to live view". */
  onSelectRun: (runId: string | null, seq: number | null) => void;
  apiPrefix?: "verification-suites" | "eval-suites";
}

export function RecentRunsBanner({
  suiteId,
  refreshKey,
  liveRunId,
  livePhase,
  selectedRunId,
  onSelectRun,
  apiPrefix = "verification-suites",
}: RecentRunsBannerProps): ReactNode {
  const [offset, setOffset] = useState<number>(0);
  const { rows, total, loading, error } = useRecentRuns(
    apiPrefix,
    suiteId,
    offset,
    refreshKey,
  );

  // Auto-snap to the newest page when a run starts
  useEffect(() => {
    if (liveRunId !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOffset(0);
    }
  }, [liveRunId]);

  // The live chip is shown only on the newest page (offset=0) and only
  // when it isn't already present in the fetched list
  const showLiveChip = useMemo(
    () =>
      offset === 0 &&
      liveRunId !== null &&
      livePhase !== null &&
      !rows.some((r) => r.id === liveRunId),
    [offset, liveRunId, livePhase, rows],
  );

  // Build the visible chip list. Newest-first matches the API, so we
  // reverse for display (oldest-on-the-left mock-up convention).
  const visible: BannerRun[] = useMemo(() => {
    const out = rows.slice();
    if (showLiveChip && liveRunId && livePhase) {
      out.unshift({
        id: liveRunId,
        status: livePhase,
        totalCount: 0,
        passedCount: 0,
        failedCount: 0,
        erroredCount: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
    }
    return out.reverse();
  }, [rows, showLiveChip, liveRunId, livePhase]);

  const canGoNewer = offset > 0;
  const canGoOlder = offset + rows.length < total;

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-auto px-1"
        onClick={() => setOffset((o) => o + LIMIT)}
        disabled={!canGoOlder || loading}
        aria-label="Older runs"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        <ChevronLeft className="-ml-2 h-3.5 w-3.5" />
      </Button>

      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {error && (
          <span className="text-[11px] text-destructive">{error}</span>
        )}
        {!error && visible.length === 0 && !loading && (
          <span className="text-[11px] text-muted-foreground">
            No runs yet
          </span>
        )}
        {visible.map((run, i) => {
          const seq = total - offset - (rows.length - 1) + i;
          return (
            <RunChip
              key={run.id}
              run={run}
              label={`#${seq}`}
              selected={run.id === selectedRunId}
              onClick={() => {
                const next: boolean = run.id !== selectedRunId;
                onSelectRun(next ? run.id : null, next ? seq : null);
              }}
            />
          );
        })}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-auto px-1"
        onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
        disabled={!canGoNewer || loading}
        aria-label="Newer runs"
      >
        <ChevronRight className="h-3.5 w-3.5" />
        <ChevronRight className="-ml-2 h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// --- Chip --------------------------------------------------------------------

interface RunChipProps {
  run: BannerRun;
  label: string;
  selected: boolean;
  onClick: () => void;
}

function RunChip({ run, label, selected, onClick }: RunChipProps): ReactNode {
  const tz = useDisplayTimezone();
  const v = statusVisual(run.status);
  const counts =
    run.status === "running"
      ? null
      : (
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {run.passedCount > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">
              ✓{run.passedCount}
            </span>
          )}
          {run.failedCount > 0 && (
            <span className="ml-1 text-red-600 dark:text-red-400">
              ✗{run.failedCount}
            </span>
          )}
          {run.erroredCount > 0 && (
            <span className="ml-1 text-amber-600 dark:text-amber-400">
              !{run.erroredCount}
            </span>
          )}
        </span>
      );

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ring-1 ring-inset transition-colors",
        v.ring,
        selected
          ? "bg-accent text-foreground"
          : cn(v.bg, "hover:brightness-110"),
      )}
      title={formatTimestamp(run.startedAt, tz)}
      aria-label={`Run ${label}, status ${run.status}`}
      aria-pressed={selected}
    >
      <span className="font-medium">{label}</span>
      {run.status === "running" ? v.icon : (
        <span aria-hidden className="text-muted-foreground/60">·</span>
      )}
      {counts}
    </button>
  );
}
