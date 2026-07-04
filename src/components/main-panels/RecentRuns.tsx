"use client";

/**
 * RecentRuns — read-only execution history for one schedule.
 *
 * Mounted as the right column of the 50/50 ScheduleEditor split. Each
 * row renders an absolute timestamp + status icon + one-line summary;
 * rows are NOT clickable (the schedule's owner already has the row
 * open in the left column, and per-run forensics live behind the
 * admin `/admin/run/[id]` page).
 *
 * Data comes from `GET /api/schedules/[id]/runs` which paginates the
 * `entity_run.schedule_id` index in DESC order. The component
 * deliberately does not auto-poll — the user can hit "Refresh"
 * (top-right) when a tick just landed.
 */

import { useCallback, useState, type ReactElement } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  History,
  Loader2,
  RefreshCw,
} from "lucide-react";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { formatTimestamp } from "@/components/admin/format";

import type {
  ScheduleRunsResponse,
  ScheduleRunSummary,
} from "@/lib/runner/schedule-runs-dto";

const fetcher = async (url: string): Promise<ScheduleRunsResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const detail: string =
      (await res.json().catch(() => ({})))?.message ??
      `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return res.json();
};

interface RecentRunsProps {
  /** Schedule id whose history we render. */
  scheduleId: string;
}

/**
 * Single-row layout used both for actual runs and the synthetic
 * "empty" message — extracted so spacing stays consistent.
 *
 * Status is encoded ONLY by the leading icon's colour (green / amber /
 * muted). A textual badge would be redundant, especially given the
 * row is dominated by the Result text.
 *
 * Schedule task is intentionally NOT repeated per row — every row in
 * this panel shares the same task (it's the schedule the user just
 * opened), so showing it would be pure noise.
 *
 * Layout: collapsed by default to a single-line preview (icon +
 * timestamp + truncated text). Clicking the row toggles a `<pre>`
 * detail block underneath with the full result, mirroring the
 * notifications page's "Result" expansion. Chevron telegraphs the
 * affordance.
 */
function RunRow({ run, tz }: { run: ScheduleRunSummary; tz: string }): ReactElement {
  const [open, setOpen] = useState(false);
  // `created_at` is always set; `finished_at` is null while the run
  // is in flight. We show the kickoff time (when the schedule fired)
  // because that's what the user is mentally indexing on.
  const ts = formatTimestamp(run.createdAt, tz);
  const hasResult = !!run.summaryLine;
  // Collapsed preview — mirror the notifications-page Context cell:
  // fold all whitespace runs (newlines, tabs, repeated spaces) into a
  // single space so the text flows as one continuous line, then let
  // CSS `truncate` cut at the available width. This way a short
  // multi-line answer stays fully visible without expanding, while a
  // long one tails off with an ellipsis.
  const previewText = hasResult
    ? run.summaryLine!.replace(/\s+/g, " ").trim()
    : null;

  return (
    <li className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        // The whole header is the click target so a click anywhere on
        // the row toggles — easier than aiming at the chevron alone.
        // Disabled when there is no result (nothing to show).
        onClick={hasResult ? () => setOpen((v) => !v) : undefined}
        disabled={!hasResult}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2.5 text-left",
          hasResult ? "hover:bg-accent/30 cursor-pointer" : "cursor-default",
        )}
        aria-expanded={hasResult ? open : undefined}
      >
        {/* Chevron — same affordance shape as collapsible lists in
            shadcn. Hidden when there's nothing to expand so the row
            doesn't lie about being interactive. */}
        {hasResult ? (
          open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <RunStatusIcon status={run.status} />
        <span className="shrink-0 text-xs font-medium tabular-nums">{ts}</span>
        {previewText ? (
          <span
            className={cn(
              "ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground",
              run.status === "failed" && "text-destructive/90",
            )}
            // Full untruncated text on hover — handy when the
            // ellipsis hides the punchline.
            title={previewText}
          >
            {previewText}
          </span>
        ) : (
          <span className="ml-2 min-w-0 flex-1 truncate text-xs italic text-muted-foreground">
            (no result captured)
          </span>
        )}
      </button>
      {open && hasResult && (
        // Mirror the notifications page's "Result" block — `<pre>`
        // preserves the agent's intentional line breaks (often
        // bulleted output) while `whitespace-pre-wrap` still wraps
        // long lines instead of forcing horizontal scroll. Indent
        // matches the chevron+icon block above.
        <pre
          className={cn(
            "mb-3 ml-10 mr-4 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 dark:bg-muted/10 px-3 py-2 text-xs leading-relaxed text-foreground",
            run.status === "failed" && "border-destructive/40 text-destructive",
          )}
        >
          {run.summaryLine}
        </pre>
      )}
    </li>
  );
}

function RunStatusIcon({ status }: { status: string }): ReactElement {
  if (status === "succeeded") {
    return (
      <CircleCheck
        className="h-3.5 w-3.5 shrink-0 text-emerald-500"
        aria-label="Succeeded"
      />
    );
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <CircleAlert
        className="h-3.5 w-3.5 shrink-0 text-amber-500"
        aria-label={status === "failed" ? "Failed" : "Cancelled"}
      />
    );
  }
  // running / awaiting_input / paused / queued — all in-flight states.
  return (
    <CircleDashed
      className="h-3.5 w-3.5 shrink-0 animate-pulse text-muted-foreground"
      aria-label={status}
    />
  );
}

export function RecentRuns({ scheduleId }: RecentRunsProps): ReactElement {
  const tz = useDisplayTimezone();
  // We don't auto-revalidate on focus — the user just navigated
  // here and the data is already fresh.
  const { data, error, isLoading, mutate } = useSWR<ScheduleRunsResponse>(
    `/api/schedules/${scheduleId}/runs?limit=20`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 items-center gap-2 border-b px-4 py-2 bg-card">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Recent runs</h2>
        {data && (
          <span className="text-[10px] text-muted-foreground">
            ({data.items.length})
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          onClick={refresh}
          disabled={isLoading}
          aria-label="Refresh runs"
          title="Refresh"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", isLoading && "animate-spin")}
          />
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {isLoading && !data ? (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <p className="m-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error instanceof Error ? error.message : String(error)}
          </p>
        ) : !data || data.items.length === 0 ? (
          <p className="px-4 py-6 text-xs text-muted-foreground">
            No runs yet. The next fire will show up here.
          </p>
        ) : (
          <ul className="flex flex-col">
            {data.items.map((run) => (
              <RunRow key={run.runId} run={run} tz={tz} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * Placeholder used when the editor is in "create" mode and no
 * schedule row exists yet to query history for. Same outer frame as
 * the real panel for visual continuity.
 */
export function RecentRunsPlaceholder(): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 items-center gap-2 border-b px-4 py-2 bg-card">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Recent runs</h2>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        Save this schedule first — its run history will appear here
        after the next fire.
      </div>
    </div>
  );
}
