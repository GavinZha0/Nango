"use client";

/**
 * TraceManagement — editor-only listing of chat traces.
 *
 * Trace-first view of `entity_run` history: one row per `thread_id` (Trace ID),
 * populated by `GET /api/trace`. The "first top-level run" of each trace
 * is the source of truth for the timestamp / task / entity / owner
 * columns; runCount, cumulativeDurationMs and worstStatus are
 * aggregated across all top-level runs.
 *
 * Click a row → `/trace/<id>`.
 */

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";

import { formatTimestamp, formatDurationMs } from "@/components/admin/format";

/** Server-side row shape. Mirrors the response of
 *  `GET /api/trace` 1:1. */
interface TraceRow {
  threadId: string;
  firstRunCreatedAt: string;
  firstRunEntityId: string;
  firstRunEntityKind: string;
  firstRunEntitySource: string;
  firstRunBuiltinName: string | null;
  firstRunCredentialName: string | null;
  firstRunTask: string;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  initiator: string;
  runCount: number;
  cumulativeDurationMs: number;
  worstStatus: string;
}

interface ListResponse {
  rows: TraceRow[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 50;

const ALL_STATUSES = [
  "queued",
  "running",
  "awaiting_input",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
] as const;
type StatusFilter = (typeof ALL_STATUSES)[number];

/** Map worstStatus → task-column text colour. Matches the priority
 *  order in `src/lib/runner/thread-metrics.ts::STATUS_PRIORITY`. */
function statusToTaskTone(status: string): string {
  switch (status) {
    case "failed":
      return "text-red-700 dark:text-red-300 font-medium";
    case "running":
      return "text-blue-700 dark:text-blue-300 font-medium";
    case "awaiting_input":
    case "paused":
    case "queued":
      return "text-amber-700 dark:text-amber-300";
    case "cancelled":
      return "text-muted-foreground";
    case "succeeded":
    default:
      return "text-foreground";
  }
}

/** Build the user-friendly entity label. */
function entityLabel(row: TraceRow): string {
  if (row.firstRunEntitySource === "builtin") {
    return row.firstRunBuiltinName
      ? `Built-in / ${row.firstRunBuiltinName}`
      : row.firstRunEntityId;
  }
  return row.firstRunCredentialName
    ? `${row.firstRunCredentialName} / ${row.firstRunEntityId}`
    : row.firstRunEntityId;
}

interface ChipGroupProps<T extends string> {
  label: string;
  options: readonly T[];
  selected: ReadonlySet<T>;
  onToggle: (value: T) => void;
}

function ChipGroup<T extends string>({
  label,
  options,
  selected,
  onToggle,
}: ChipGroupProps<T>): ReactNode {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <div className="inline-flex flex-wrap gap-1">
        {options.map((opt) => {
          const active = selected.has(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className={cn(
                "rounded border px-2 py-0.5 font-mono text-[10px] transition-colors",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TraceManagement(): ReactNode {
  const tz = useDisplayTimezone();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [statuses, setStatuses] = useState<Set<StatusFilter>>(new Set());
  const [offset, setOffset] = useState(0);

  const queryString = useMemo(() => {
    const u = new URLSearchParams();
    if (statuses.size > 0) u.set("status", [...statuses].join("|"));
    u.set("limit", String(PAGE_SIZE));
    u.set("offset", String(offset));
    return u.toString();
  }, [statuses, offset]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const res = await fetch(`/api/trace?${queryString}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as ListResponse;
        if (!cancelled) setData(d);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  const toggleSet = <T extends string>(
    s: Set<T>,
    setter: (next: Set<T>) => void,
    value: T,
  ): void => {
    const next = new Set(s);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
    setOffset(0);
  };

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4 rounded-md border bg-card/50 px-3 py-2">
        <ChipGroup
          label="Status"
          options={ALL_STATUSES}
          selected={statuses}
          onToggle={(v) => toggleSet(statuses, setStatuses, v)}
        />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">Timestamp</TableHead>
              <TableHead className="w-28">Trace id</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="w-48">Entity</TableHead>
              <TableHead className="w-40">User</TableHead>
              <TableHead className="w-24">Initiator</TableHead>
              <TableHead className="w-16 text-right">Runs</TableHead>
              <TableHead className="w-24">Compute</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-10 text-center text-xs text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-10 text-center text-xs text-muted-foreground"
                >
                  No traces match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const taskTone = statusToTaskTone(row.worstStatus);
                const href = `/trace/${row.threadId}`;
                const userLabel =
                  row.ownerName ?? row.ownerEmail ?? row.ownerId;
                return (
                  <TableRow key={row.threadId} className="cursor-pointer">
                    <TableCell
                      className="whitespace-nowrap text-xs text-muted-foreground"
                      title={row.firstRunCreatedAt}
                    >
                      <Link href={href} className="hover:underline">
                        {formatTimestamp(row.firstRunCreatedAt, tz)}
                      </Link>
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap font-mono text-[10px] text-muted-foreground"
                      title={row.threadId}
                    >
                      <Link href={href} className="hover:underline">
                        …{row.threadId.slice(-8)}
                      </Link>
                    </TableCell>
                    <TableCell
                      className={cn("max-w-0 truncate text-xs", taskTone)}
                      title={`${row.worstStatus.toUpperCase()} · ${row.firstRunTask}`}
                    >
                      <Link href={href}>{row.firstRunTask}</Link>
                    </TableCell>
                    <TableCell className="max-w-[12rem] truncate text-xs">
                      <Link href={href} className="text-foreground">
                        {entityLabel(row)}
                      </Link>
                    </TableCell>
                    <TableCell
                      className="truncate text-xs"
                      title={row.ownerEmail ?? row.ownerId}
                    >
                      <Link href={href} className="text-foreground">
                        {userLabel}
                      </Link>
                    </TableCell>
                    <TableCell className="truncate text-xs font-mono capitalize">
                      <Link href={href} className="text-foreground">
                        {row.initiator}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      <Link href={href}>{row.runCount}</Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      <Link href={href}>
                        {row.cumulativeDurationMs > 0
                          ? formatDurationMs(row.cumulativeDurationMs)
                          : "—"}
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total === 0 ? "0 traces" : `${start}–${end} of ${total} traces`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || loading}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={end >= total || loading}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
