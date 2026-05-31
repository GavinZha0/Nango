"use client";

/**
 * ThreadDetailView — admin-only forensics page for a single thread.
 *
 * Layout:
 *   ┌─ Header (sticky)
 *   ├─ Thread Summary Card
 *   └─ 2-col grid
 *         Left  — vertical run timeline (one card per top-level run,
 *                 sub-runs nested with indentation). Click a card → set
 *                 `?run=<id>` in the URL → right column updates.
 *         Right — EventTimeline for the selected run. Events are
 *                 fetched lazily via `GET /api/admin/runs/[id]`.
 *
 * Right-column selection is URL-driven so admins can deep-link to
 * "this specific run inside this thread" — e.g. share the link with a
 * teammate during a forensics session.
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
} from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import {
  EventTimeline,
  type EventRowData,
} from "@/components/admin/EventTimeline";
import {
  formatAbsolute,
  formatDuration,
  formatDurationMs,
} from "@/components/admin/format";
import { StatusBadge } from "@/components/admin/StatusBadge";

// ---------------------------------------------------------------------------
// Wire-shape mirrors `GET /api/admin/threads/[id]` (commit 63315c5).
// ---------------------------------------------------------------------------

/** Supervisor's two delegation tools — both create a sub-run row
 *  (linked via `parent_run_id` + inherited `thread_id`). The UI
 *  renders these as "Sub-run" rows separately from genuine tools so
 *  delegations aren't double-counted alongside `run_code_in_sandbox`
 *  / MCP / SSH tool calls. Keep in sync with
 *  `src/lib/runner/supervisor-tools.server.ts`. */
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

interface ThreadSummary {
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

interface ThreadDetailResponse {
  threadId: string;
  summary: ThreadSummary;
  runs: ReadonlyArray<RunWithMetrics>;
}

/** Right-column event-fetch shape; mirrors `GET /api/admin/runs/[id]`'s
 *  `events` array. The endpoint also returns `run` and `children` but
 *  the thread detail view doesn't consume those — `run` is already in
 *  the thread payload, and `children` is shown by the timeline tree. */
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

/** Map run status → tiny inline icon used in the run-card header.
 *  Coloured icons, NOT a full badge, so the timeline reads compactly. */
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
    status === "running"
    || status === "queued"
    || status === "awaiting_input"
    || status === "paused"
  ) {
    return <Clock className={cn(cls, "text-blue-600 dark:text-blue-400")} />;
  }
  return <AlertTriangle className={cn(cls, "text-amber-600 dark:text-amber-400")} />;
}

/** Map tool-call status → tinted Hammer icon. A Hammer (not a check
 *  / cross / clock) is used here to visually distinguish tool rows
 *  from the run-status icon on Row 1 of the same card — the shape
 *  says "tool" and the colour says "how the tool finished".
 *
 *  Three colours (red / amber / blue) instead of four:
 *   - red    = failure (result reported an error)
 *   - amber  = warning OR pending — both mean "no clean result"
 *              (detector flagged the payload, OR no `tool_call_result`
 *              has been paired with the chunk yet, e.g. forwarded to
 *              a continuation run or the agent died after emitting
 *              the chunk). Admin should look closer in either case.
 *   - blue   = clean success
 *
 *  Green is deliberately reserved for high-signal run-level outcomes
 *  ("run finished") so tool rows don't drown the timeline in green.
 *
 *  The 4-value API `status` field (`success | failure | warning |
 *  pending`) is preserved so future UI iterations (e.g. a forwarded
 *  state surfaced by cross-run resolution) can re-split colours
 *  without an API change. */
function ToolStatusIcon({ status }: { status: ToolCallSummary["status"] }): ReactNode {
  const cls = "h-3 w-3 shrink-0";
  if (status === "failure") {
    return <Hammer className={cn(cls, "text-red-600 dark:text-red-400")} />;
  }
  if (status === "warning" || status === "pending") {
    return <Hammer className={cn(cls, "text-amber-600 dark:text-amber-400")} />;
  }
  // success
  return <Hammer className={cn(cls, "text-blue-600 dark:text-blue-400")} />;
}

/** Map delegate tool-call status → tinted Sparkles icon. Mirrors
 *  the chat-side `DelegateToAgentCard` visual identity (purple +
 *  Sparkles) so admin views and chat views read with the same
 *  vocabulary: shape = "this is a delegation"; colour = "how it
 *  went". Success uses purple (not blue) precisely to match the
 *  chat card. failure / warning / pending re-use the regular tool
 *  palette because those concerns are status-shaped, not
 *  identity-shaped. */
function DelegateStatusIcon({ status }: { status: ToolCallSummary["status"] }): ReactNode {
  const cls = "h-3 w-3 shrink-0";
  if (status === "failure") {
    return <Sparkles className={cn(cls, "text-red-600 dark:text-red-400")} />;
  }
  if (status === "warning" || status === "pending") {
    return <Sparkles className={cn(cls, "text-amber-600 dark:text-amber-400")} />;
  }
  // success
  return <Sparkles className={cn(cls, "text-purple-600 dark:text-purple-300")} />;
}

/** Right-aligned duration / status text on a tool-call row.
 *  "running…" is reserved for live runs (run.status === "running")
 *  so a `pending` tool on a `succeeded` / `failed` run reads as
 *  "—" — the chunk just never paired with a result. */
function toolDurationLabel(
  tc: ToolCallSummary,
  runStatus: string,
): string {
  if (tc.durationMs !== null) return formatDurationMs(tc.durationMs);
  if (tc.status === "pending" && runStatus === "running") return "running…";
  return "—";
}

// ---------------------------------------------------------------------------
// Run timeline card (recursive — top-level runs render their sub-runs
// inline with a left-padded indent for visual hierarchy).
// ---------------------------------------------------------------------------

function RunCard({
  run,
  ordinalLabel,
  childrenByParent,
  selectedRunId,
  onSelect,
  depth,
}: {
  run: RunWithMetrics;
  /** "#1", "#2.a", etc. — admin-friendly label that encodes the
   *  position in the thread + sub-tree. */
  ordinalLabel: string;
  childrenByParent: Map<string, RunWithMetrics[]>;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  /** 0 = top-level, deeper for sub-runs. Drives indentation but is
   *  also bounded so an unexpectedly deep tree (debate sub-run forest)
   *  doesn't blow out the column width. */
  depth: number;
}): ReactNode {
  const subRuns = childrenByParent.get(run.id) ?? [];
  const isSelected = selectedRunId === run.id;
  const taskPreview = run.inputTask.split("\n")[0] ?? "";
  const taskTruncated =
    taskPreview.length > 200 ? `${taskPreview.slice(0, 200)}…` : taskPreview;

  // Partition tool calls — delegate_to_agent / delegate_async are the
  // entry points that produce the sub-runs nested below this card, so
  // they render as their own "Sub-run" rows (Row 3) instead of being
  // mixed in with genuine tools (Row 4).
  const delegateCalls = run.metrics.toolCalls.filter(isDelegateCall);
  const regularCalls = run.metrics.toolCalls.filter((tc) => !isDelegateCall(tc));

  return (
    <div
      // Cap the visual indent so deeply-nested sub-trees stay readable.
      // Tailwind doesn't allow arbitrary calc() inside the class string,
      // so an inline style is the cleanest way to drive the indent.
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
        {/* Row 1 — status · ordinal · timestamp · entity (flex-grow)
            · TTFT · Compute. The two perf numbers sit at the right
            end so admins can scan a column of run cards and compare
            them aligned. TTFT is rendered first (it happens first
            chronologically inside a run) followed by Compute. */}
        <div className="flex items-center gap-2">
          <StatusIcon status={run.status} />
          <span className="font-mono text-[10px] text-muted-foreground">
            {ordinalLabel}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {formatAbsolute(run.startedAt ?? run.createdAt)}
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
        {/* Row 2 — task preview. Tinted red when the run failed so a
            scrolling admin can spot trouble even before reading the
            text. */}
        <div
          className={cn(
            "mt-1 text-xs break-words whitespace-normal",
            run.status === "failed" ? "text-destructive" : "text-foreground",
          )}
        >
          {run.errorMessage ?? taskTruncated}
        </div>
        {/* Row 3 — delegate tool calls. Each row maps 1:1 to a sub-run
            shown indented below: `delegate_to_agent` / `delegate_async`
            ARE the entry point that creates the sub-run, so listing
            them in Row 4 alongside genuine tools (run_code_in_sandbox,
            extract_dataset_by_sql, MCP, ...) would double-count the
            delegation. Each row shows the tool name and the wall-clock
            from `tool_call_chunk` to `tool_call_result` — which on
            `delegate_to_agent` (sync) is the whole sub-run duration,
            and on `delegate_async` is just the queue-handoff time. */}
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
        {/* Row 4 — non-delegate tool calls (compact one-per-line).
            Capped at 8 visible to keep the card height bounded; if
            more exist a "+N more" line summarises. */}
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

      {/* Sub-runs recurse. */}
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread summary card
// ---------------------------------------------------------------------------

function ThreadSummaryCard({ summary }: { summary: ThreadSummary }): ReactNode {
  // Five stats per the design: Runs · Sub-runs · Duration (wall-clock
  // conversation span) · Cumulative compute · Avg TTFT.
  //
  // Owner / Started / Last activity / Worst status / Failed count are
  // intentionally NOT surfaced here — owner shows up in the page header
  // implicitly (the admin already filtered through the thread list to
  // get here), worst status is on the header badge, started/last are
  // implicit from the timeline scroll, and failed runs are picked up
  // visually from the red `XCircle` icons on the run cards.
  //
  // Duration (wall-clock) uses `formatDuration(start, end)` so a
  // still-running thread renders live elapsed time on each render
  // (the helper falls back to `Date.now()` when `end` is null).
  return (
    <section className="rounded-md border bg-card/40 p-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Runs" value={String(summary.topLevelRunCount)} />
        <Stat label="Sub-runs" value={String(summary.subRunCount)} />
        {/* Timing column order matches the "first to last" reading of a
            single run: TTFT (until first token) → Compute (cumulative
            sum of run start→finish across all runs) → Duration
            (wall-clock from first run started to last run finished). */}
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

export function ThreadDetailView({ threadId }: { threadId: string }): ReactNode {
  const [data, setData] = useState<ThreadDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ----- thread fetch -----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/admin/threads/${threadId}`);
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error((body && body.message) || `HTTP ${r.status}`);
        }
        const d = (await r.json()) as ThreadDetailResponse;
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
  }, [threadId]);

  // ----- selected run state, driven by ?run= query string -----
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedRunId = searchParams.get("run");

  const onSelectRun = useCallback(
    (runId: string) => {
      // Preserve other query params (currently none on this page, but
      // future-proof for filters).
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("run", runId);
      router.replace(`/admin/thread/${threadId}?${sp.toString()}`, {
        scroll: false,
      });
    },
    [router, searchParams, threadId],
  );

  // ----- structured derived data (memoised on the response) -----
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
    // Stable sort by createdAt so sub-run ordering matches the
    // backend's `ORDER BY created_at asc`.
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
        {error ?? "Thread not found."}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 border-b px-6 py-3">
        <Link
          href="/admin/thread"
          aria-label="Back to threads"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="font-mono text-xs">Thread {threadId}</h1>
        <span className="ml-auto">
          <StatusBadge status={data.summary.worstStatus} />
        </span>
      </header>

      {/* Summary card */}
      <div className="border-b px-6 py-4">
        <ThreadSummaryCard summary={data.summary} />
      </div>

      {/* Two-column body with a [2fr_3fr] ratio so the left has room
          for run cards and the right keeps width for event payloads.
          QUIRK: `min-w-0` on each grid child is required for the fr
          ratio to actually hold. Without it, CSS grid's default
          `min-width: auto` (= min-content) lets a long unbreakable
          descendant (uuid, url) override the fr calculation and push
          one column past its share. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[2fr_3fr]">
        {/* Left column — run timeline */}
        <ScrollArea className="min-h-0 min-w-0 border-r">
          <div className="flex flex-col gap-2 px-4 py-4">
            {topLevel.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No runs in this thread.
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
                />
              ))
            )}
          </div>
        </ScrollArea>

        {/* Right column — event timeline for the selected run. Empty
            placeholder when no run is selected. */}
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

// ---------------------------------------------------------------------------
// Right column — EventTimeline for the selected run.
// All identifying information (status / TTFT / tools / sub-runs / task /
// error) is already on the left-column run card, so the right column is
// dedicated to the event log — admins came here to read events, not to
// re-read fields they already saw two columns away.
// ---------------------------------------------------------------------------

function RunDetailPane({ run }: { run: RunWithMetrics }): ReactNode {
  const [events, setEvents] = useState<EventRowData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      // Clear stale events from the previous run on the same render
      // pass as `setLoading(true)` — both fire from the async IIFE so
      // React batches them, and the column shows a brief "Loading…"
      // instead of the previous run's events leaking through.
      setEvents(null);
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/admin/runs/${run.id}`);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Events{" "}
          {events && events.length > 0
            && `(${events.length}${truncated ? "+" : ""})`}
        </h2>
        {/* Run id right-aligned. The `(N+)` suffix on the title
            already conveys "truncated" without a separate note. */}
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
