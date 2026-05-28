"use client";

/**
 * SchedulesPanel — left-side panel listing the user's schedules.
 *
 * Row anatomy mirrors the rest of the left panels (Agent / Skill /
 * DataSource / SSH / MCP):
 *
 *   line 1 — name (left, click to open) + status icon (right)
 *   line 2 — source label, only when a custom name is set (so the row
 *            still tells the user *what* fires; otherwise the source
 *            already lives in line 1)
 *   line 3 — trigger spec + relative-time "next" hint
 *
 * Delete lives in the editor's header (next to Save), not the row —
 * matches the AgentEditor / SkillEditor / DataSourceEditor /
 * SshServerEditor convention and keeps stray hover trash off the list.
 */

import { useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Calendar,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Plus,
  RefreshCw,
} from "lucide-react";

// Per-row detail in this panel is intentionally minimal: heading,
// status, trigger spec, and the upcoming fire. Past-run details
// (last-fire time, error message, full history) live in the
// right-hand `RecentRuns` panel inside ScheduleEditor.

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  scheduleActions,
  useSchedulesStore,
  type ScheduleIntervalUnit,
  type ScheduleResponse,
} from "@/store/schedules";

const UNIT_NOUN: Record<ScheduleIntervalUnit, string> = {
  minute: "min",
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
};

/**
 * Render the trigger spec as a single short line. Avoids cron
 * jargon — the user gets a phrase that matches what they typed in
 * the editor.
 */
function describeTrigger(row: ScheduleResponse): string {
  if (row.intervalValue === null || row.intervalUnit === null) {
    return "once";
  }
  const unit = UNIT_NOUN[row.intervalUnit];
  const plural = row.intervalValue !== 1 ? "s" : "";
  return `every ${row.intervalValue} ${unit}${plural}`;
}

/** Forward-only relative formatter for the "next 5m" hint. Past-tense
 *  history rendering lives in RecentRuns and uses absolute timestamps. */
function formatRelativeFuture(iso: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const m = Math.round(diff / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.round(h / 24);
  return `in ${d}d`;
}

/**
 * Status pill — also the inline enabled toggle. Three visual states:
 *
 *   - disabled        → CircleSlash (muted)
 *   - enabled + ok    → CircleCheck (emerald)
 *   - enabled + error → CircleAlert (amber)  // last fire failed
 *
 * All three are clickable and flip `enabled`. The error state is still
 * "enabled, but last fire failed" — clicking it disables the schedule
 * so the user can investigate without further fires. Matches the
 * inline-toggle pattern used by the rest of the left panels (Agent /
 * Skill / DataSource / SSH).
 *
 * No isOwner gating: `/api/schedules` is `withSession` + `ownerId`
 * filtered, so every row reaching the panel is the user's own.
 */
function StatusToggle({
  row,
  onToggle,
}: {
  row: ScheduleResponse;
  onToggle: () => void;
}): ReactNode {
  const icon = !row.enabled ? (
    <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
  ) : row.lastError ? (
    <CircleAlert className="h-3.5 w-3.5 text-amber-500" />
  ) : (
    <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />
  );
  const label = !row.enabled
    ? "Enable schedule"
    : row.lastError
      ? "Disable schedule (last fire failed)"
      : "Disable schedule";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      className="shrink-0 cursor-pointer rounded p-0.5 hover:text-foreground"
    >
      {icon}
    </button>
  );
}

interface ScheduleRowProps {
  row: ScheduleResponse;
  /** True when the current route is /schedule/<row.id>. Drives the
   *  selected-row highlight, matching McpPanel / SkillsPanel / etc. */
  active: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
}

function ScheduleRow({
  row,
  active,
  onSelect,
  onToggleEnabled,
}: ScheduleRowProps): ReactNode {
  const heading = row.name ?? row.sourceLabel;
  // Custom-named schedules show the underlying source on line 2 so the
  // user still knows *what* fires; auto-named ones already display the
  // source as their heading, so the extra line would be redundant.
  const showSourceLine = Boolean(row.name && row.sourceLabel && row.name !== row.sourceLabel);

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      {/* Line 1: name (clickable) + status icon (right cluster) */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-base font-medium hover:underline underline-offset-2"
          aria-label={`Open ${heading}`}
        >
          {heading}
        </button>
        <StatusToggle row={row} onToggle={onToggleEnabled} />
      </div>

      {/* Line 2 — source (only when a custom name is set) */}
      {showSourceLine && (
        <p className="truncate text-xs text-muted-foreground">
          {row.sourceLabel}
        </p>
      )}

      {/* Line 3 — trigger spec + next-fire hint */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <CalendarClock className="h-3 w-3 shrink-0" />
        <span className="truncate">{describeTrigger(row)}</span>
        {row.enabled && row.nextRunAt && (
          <span className="shrink-0">
            · next {formatRelativeFuture(row.nextRunAt)}
          </span>
        )}
      </div>
    </div>
  );
}

export function SchedulesPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const items = useSchedulesStore((s) => s.items);
  const loaded = useSchedulesStore((s) => s.loaded);
  const loading = useSchedulesStore((s) => s.loading);
  const error = useSchedulesStore((s) => s.error);

  // Active row id: derived from /schedule/<id>. `new` is the create
  // sentinel; skipping it keeps the highlight off mid-creation.
  const schedMatch = pathname.match(/^\/schedule\/([^/]+)/);
  const activeScheduleId =
    schedMatch && schedMatch[1] !== "new" ? schedMatch[1] : null;

  useEffect(() => {
    if (!loaded) void scheduleActions.refresh();
  }, [loaded]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — same shape as McpPanel for a familiar rhythm. */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Schedules</h2>
        {items.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            ({items.length})
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => router.push("/schedule/new")}
            aria-label="New schedule"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void scheduleActions.refresh()}
            disabled={loading}
            aria-label="Refresh schedules"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          {error && (
            <p className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}
          {!loaded && loading ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <div className="px-4 py-4 text-xs text-muted-foreground">
              No schedules yet.{" "}
              <button
                type="button"
                className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                onClick={() => router.push("/schedule/new")}
              >
                Add one
              </button>
            </div>
          ) : (
            items.map((row) => (
              <ScheduleRow
                key={row.id}
                row={row}
                active={row.id === activeScheduleId}
                onSelect={() => router.push(`/schedule/${row.id}`)}
                onToggleEnabled={() =>
                  void scheduleActions.patch(row.id, {
                    enabled: !row.enabled,
                  })
                }
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
