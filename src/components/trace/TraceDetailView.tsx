"use client";

/**
 * TraceDetailView — editor-only forensics page for a single trace.
 *
 * Layout:
 *   ┌─ Header (sticky)
 *   ├─ Trace Summary Card
 *   └─ 2-col grid
 *         Left  — vertical run timeline (one card per top-level run,
 *                 sub-runs nested with indentation). Click a card → set
 *                 `?run=<id>` in the URL → right column updates.
 *         Right — EventTimeline for the selected run. Events are
 *                 fetched lazily via `GET /api/trace/runs/[id]`.
 *
 * Right-column selection is URL-driven so users can deep-link to
 * "this specific run inside this trace".
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Hammer,
  Sparkles,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import {
  EventTimeline,
  type EventRowData,
} from "@/components/trace/EventTimeline";
import {
  formatTimestamp,
  formatDuration,
  formatDurationMs,
} from "@/components/admin/format";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";

// ---------------------------------------------------------------------------
// Wire-shape mirrors `GET /api/trace/[id]`
// ---------------------------------------------------------------------------

const DELEGATE_TOOL_NAMES = new Set<string>([
  "delegate_to_agent",
  "delegate_async",
]);

interface ToolCallSummary {
  toolCallId: string;
  toolName: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "success" | "failure" | "warning" | "pending";
}

interface RunMetrics {
  ttftMs: number | null;
  durationMs: number | null;
  toolCalls: ReadonlyArray<ToolCallSummary>;
  subRunCount: number;
}

interface RunWithMetrics {
  id: string;
  parentRunId: string | null;
  threadId: string | null;
  initiator: string;
  entityId: string;
  entityKind: string;
  entitySource: string;
  credentialId: string | null;
  builtinName: string | null;
  credentialName: string | null;
  mode: string;
  status: string;
  inputTask: string;
  errorMessage: string | null;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  metrics: RunMetrics;
}

interface TraceSummary {
  threadId: string;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  firstRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  topLevelRunCount: number;
  subRunCount: number;
  cumulativeDurationMs: number;
  avgTtftMs: number | null;
  failedCount: number;
  worstStatus: string;
}

interface TraceDetailResponse {
  threadId: string;
  summary: TraceSummary;
  runs: ReadonlyArray<RunWithMetrics>;
}

interface RunEventsResponse {
  events: EventRowData[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDelegateCall(tc: ToolCallSummary): boolean {
  return tc.toolName !== null && DELEGATE_TOOL_NAMES.has(tc.toolName);
}

function entityLabel(row: {
  entitySource: string;
  entityId: string;
  builtinName: string | null;
  credentialName: string | null;
}): string {
  if (row.entitySource === "builtin") {
    return row.builtinName ? `Built-in / ${row.builtinName}` : row.entityId;
  }
  return row.credentialName
    ? `${row.credentialName} / ${row.entityId}`
    : row.entityId;
}

function StatusIcon({ status }: { status: string }): ReactNode {
  const cls = "h-4 w-4 shrink-0";
  if (status === "succeeded") {
    return (
      <CheckCircle2 className={cn(cls, "text-emerald-600 dark:text-emerald-400")} />
    );
  }
  if (status === "failed") {
    return <XCircle className={cn(cls, "text-red-600 dark:text-red-400")} />;
  }
  if (status === "cancelled") {
    return <XCircle className={cn(cls, "text-muted-foreground")} />;
  }
  if (
    status === "running" ||
    status === "queued" ||
    status === "awaiting_input" ||
    status === "paused"
  ) {
    return <Clock className={cn(cls, "text-blue-600 dark:text-blue-400")} />;
  }
  return <AlertTriangle className={cn(cls, "text-amber-600 dark:text-amber-400")} />;
}

function ToolStatusIcon({ status }: { status: ToolCallSummary["status"] }): ReactNode {
  const cls = "h-3 w-3 shrink-0";
  if (status === "failure") {
    return <Hammer className={cn(cls, "text-red-600 dark:text-red-400")} />;
  }
  if (status === "warning" || status === "pending") {
    return <Hammer className={cn(cls, "text-amber-600 dark:text-amber-400")} />;
  }
  return <Hammer className={cn(cls, "text-blue-600 dark:text-blue-400")} />;
}

function DelegateStatusIcon({ status }: { status: ToolCallSummary["status"] }): ReactNode {
  const cls = "h-3 w-3 shrink-0";
  if (status === "failure") {
    return <Sparkles className={cn(cls, "text-red-600 dark:text-red-400")} />;
  }
  if (status === "warning" || status === "pending") {
    return <Sparkles className={cn(cls, "text-amber-600 dark:text-amber-400")} />;
  }
  return <Sparkles className={cn(cls, "text-purple-600 dark:text-purple-300")} />;
}

function toolDurationLabel(tc: ToolCallSummary, runStatus: string): string {
  if (tc.durationMs !== null) return formatDurationMs(tc.durationMs);
  if (tc.status === "pending" && runStatus === "running") return "running…";
  return "—";
}

// ---------------------------------------------------------------------------
// Run timeline card (recursive)
// ---------------------------------------------------------------------------

function RunCard({
  run,
  ordinalLabel,
  childrenByParent,
  selectedRunId,
  onSelect,
  depth,
  tz,
}: {
  run: RunWithMetrics;
  ordinalLabel: string;
  childrenByParent: Map<string, RunWithMetrics[]>;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  tz: string;
  depth: number;
}): ReactNode {
  const subRuns = childrenByParent.get(run.id) ?? [];
  const isSelected = selectedRunId === run.id;
  const taskPreview = run.inputTask.split("\n")[0] ?? "";
  const taskTruncated =
    taskPreview.length > 200 ? `${taskPreview.slice(0, 200)}…` : taskPreview;

  const delegateCalls = run.metrics.toolCalls.filter(isDelegateCall);
  const regularCalls = run.metrics.toolCalls.filter((tc) => !isDelegateCall(tc));

  return (
    <div
      style={{ marginLeft: `${Math.min(depth, 3) * 1.25}rem` }}
      className="relative"
    >
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        className={cn(
          "w-full rounded-md border bg-card/50 px-3 py-2 text-left transition-colors",
          "hover:bg-accent/30",
          isSelected
            ? "border-blue-500 ring-2 ring-blue-500/40"
            : "border-border",
        )}
      >
        <div className="flex items-center gap-2">
          <StatusIcon status={run.status} />
          <span className="font-mono text-[10px] text-muted-foreground">
            {ordinalLabel}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {formatTimestamp(run.startedAt ?? run.createdAt, tz, "datetimePrecise")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
            {entityLabel(run)}
          </span>
          {run.metrics.ttftMs !== null && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              TTFT {formatDurationMs(run.metrics.ttftMs)}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatDuration(run.startedAt, run.finishedAt)}
          </span>
        </div>
        <div
          className={cn(
            "mt-1 text-xs break-words whitespace-normal",
            run.status === "failed" ? "text-destructive" : "text-foreground",
          )}
        >
          {run.errorMessage ?? taskTruncated}
        </div>
        {delegateCalls.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {delegateCalls.map((tc) => (
              <div
                key={tc.toolCallId}
                className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
              >
                <DelegateStatusIcon status={tc.status} />
                <span className="truncate">{tc.toolName ?? "delegate"}</span>
                <span className="shrink-0">
                  {toolDurationLabel(tc, run.status)}
                </span>
              </div>
            ))}
          </div>
        )}
        {regularCalls.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {regularCalls.slice(0, 8).map((tc) => (
              <div
                key={tc.toolCallId}
                className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
              >
                <ToolStatusIcon status={tc.status} />
                <span className="truncate">{tc.toolName ?? tc.toolCallId.slice(-8)}</span>
                <span className="shrink-0">
                  {toolDurationLabel(tc, run.status)}
                </span>
              </div>
            ))}
            {regularCalls.length > 8 && (
              <div className="font-mono text-[10px] text-muted-foreground">
                + {regularCalls.length - 8} more tool
                {regularCalls.length - 8 === 1 ? "" : "s"}
              </div>
            )}
          </div>
        )}
      </button>

      {subRuns.length > 0 && (
        <div className="mt-1 space-y-1">
          {subRuns.map((sub, i) => (
            <RunCard
              key={sub.id}
              run={sub}
              ordinalLabel={`${ordinalLabel}.${String.fromCharCode(97 + i)}`}
              childrenByParent={childrenByParent}
              selectedRunId={selectedRunId}
              onSelect={onSelect}
              depth={depth + 1}
              tz={tz}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trace summary card
// ---------------------------------------------------------------------------

function TraceSummaryCard({ summary }: { summary: TraceSummary }): ReactNode {
  return (
    <section className="rounded-md border bg-card py-2 px-4 shadow-sm">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Runs" value={String(summary.topLevelRunCount)} />
        <Stat label="Sub-runs" value={String(summary.subRunCount)} />
        <Stat
          label="Avg TTFT"
          value={summary.avgTtftMs !== null ? formatDurationMs(summary.avgTtftMs) : "—"}
        />
        <Stat
          label="Cumulative compute"
          value={formatDurationMs(summary.cumulativeDurationMs)}
        />
        <Stat
          label="Duration"
          value={formatDuration(
            summary.firstRunStartedAt,
            summary.lastRunFinishedAt,
          )}
        />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-xs text-foreground">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TraceDetailView({ traceId }: { traceId: string }): ReactNode {
  const tz = useDisplayTimezone();
  const [data, setData] = useState<TraceDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/trace/${traceId}`);
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error((body && body.message) || `HTTP ${r.status}`);
        }
        const d = (await r.json()) as TraceDetailResponse;
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedRunId = searchParams.get("run");

  const onSelectRun = useCallback(
    (runId: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("run", runId);
      router.replace(`/trace/${traceId}?${sp.toString()}`, {
        scroll: false,
      });
    },
    [router, searchParams, traceId],
  );

  const { topLevel, childrenByParent, selectedRun } = useMemo(() => {
    if (!data) {
      return {
        topLevel: [] as ReadonlyArray<RunWithMetrics>,
        childrenByParent: new Map<string, RunWithMetrics[]>(),
        selectedRun: null as RunWithMetrics | null,
      };
    }
    const top: RunWithMetrics[] = [];
    const byParent = new Map<string, RunWithMetrics[]>();
    for (const r of data.runs) {
      if (r.parentRunId === null) {
        top.push(r);
      } else {
        const list = byParent.get(r.parentRunId);
        if (list) list.push(r);
        else byParent.set(r.parentRunId, [r]);
      }
    }
    top.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const list of byParent.values()) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    const sel = selectedRunId
      ? data.runs.find((r) => r.id === selectedRunId) ?? null
      : null;
    return { topLevel: top, childrenByParent: byParent, selectedRun: sel };
  }, [data, selectedRunId]);

  if (loading) {
    return <p className="px-8 py-10 text-xs text-muted-foreground">Loading…</p>;
  }
  if (error || !data) {
    return (
      <p className="px-8 py-10 text-xs text-destructive">
        {error ?? "Trace not found."}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-6 py-2">
        <Link
          href="/trace"
          aria-label="Back to traces"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="font-mono text-xs">Trace {traceId}</h1>
        <span className="ml-auto">
          <StatusBadge status={data.summary.worstStatus} />
        </span>
      </header>

      <div className="border-b px-6 py-2">
        <TraceSummaryCard summary={data.summary} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[3fr_7fr]">
        <ScrollArea className="min-h-0 min-w-0 border-r">
          <div className="flex flex-col gap-2 px-4 py-4">
            {topLevel.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No runs in this trace.
              </p>
            ) : (
              topLevel.map((r, i) => (
                <RunCard
                  key={r.id}
                  run={r}
                  ordinalLabel={`#${i + 1}`}
                  childrenByParent={childrenByParent}
                  selectedRunId={selectedRunId}
                  onSelect={onSelectRun}
                  depth={0}
                  tz={tz}
                />
              ))
            )}
          </div>
        </ScrollArea>

        <div className="flex min-h-0 min-w-0 flex-col">
          {selectedRun ? (
            <RunDetailPane run={selectedRun} />
          ) : (
            <p className="flex h-full items-center justify-center px-4 text-xs text-muted-foreground">
              Select a run from the timeline to view its details.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetailPane({ run }: { run: RunWithMetrics }): ReactNode {
  const [events, setEvents] = useState<EventRowData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isInputOpen, setIsInputOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setEvents(null);
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/trace/runs/${run.id}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as RunEventsResponse;
        if (!cancelled) setEvents(d.events);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run.id]);

  const truncated = events?.length === 1000;

  // Single line text preview when collapsed
  const singleLineTask = useMemo(() => {
    const single = run.inputTask.replace(/\s+/g, " ");
    return single.length > 80 ? `${single.slice(0, 80)}…` : single;
  }, [run.inputTask]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Input Task Collapsible Banner */}
      <div className="border-b px-4 py-3 flex flex-col bg-card/10">
        <button
          type="button"
          onClick={() => setIsInputOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          <span className="text-muted-foreground shrink-0">
            {isInputOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </span>
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
            Input Task
          </span>
          {!isInputOpen && (
            <span className="text-xs text-muted-foreground truncate font-mono ml-2 min-w-0 flex-1">
              {singleLineTask}
            </span>
          )}
        </button>

        {isInputOpen && (
          <div className="mt-2 font-mono text-xs text-foreground bg-muted/40 dark:bg-muted/10 border rounded-md p-3 whitespace-pre-wrap break-all overflow-y-auto max-h-[7.5rem] scrollbar-thin">
            {run.inputTask}
          </div>
        )}
      </div>

      {/* Events Header */}
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5 bg-card">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Events{" "}
          {events && events.length > 0 && `(${events.length}${truncated ? "+" : ""})`}
        </h2>
        <span
          className="truncate font-mono text-[10px] text-muted-foreground"
          title={run.id}
        >
          {run.id}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Loading events…</p>
        ) : error ? (
          <p className="px-4 py-3 text-xs text-destructive">{error}</p>
        ) : events === null || events.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No events recorded (run may pre-date the 7-day retention window).
          </p>
        ) : (
          <EventTimeline events={events} />
        )}
      </ScrollArea>
    </div>
  );
}
