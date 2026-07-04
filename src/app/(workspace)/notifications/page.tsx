"use client";

/**
 * /notifications — full-area management page for the inbox.
 */

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  Trash2,
} from "lucide-react";

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
import { useNotificationsStore, useBellItems } from "@/store/notifications";
import { notificationActions } from "@/hooks/useNotifications";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { formatTimestamp } from "@/components/admin/format";
import type { NotificationEntity } from "@/lib/db/schema";

type Filter = "all" | "unread" | "read" | "errors";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  unread: "Unread",
  read: "Read",
  errors: "Errors",
};

/**
 * Render a kind as a coloured icon (same vocabulary as the
 * RecentRuns panel in ScheduleEditor). The kind string itself stays
 * the wire form for filtering / matching; this is pure visual.
 *
 * `aria-label` carries the human-readable status so screen readers
 * still get the equivalent of the old text badge.
 */
function KindIcon({ kind }: { kind: string }): ReactNode {
  if (kind === "run_completed") {
    return (
      <CircleCheck
        className="h-3.5 w-3.5 shrink-0 text-emerald-500"
        aria-label="Completed"
      />
    );
  }
  if (kind === "run_failed") {
    return (
      <CircleAlert
        className="h-3.5 w-3.5 shrink-0 text-amber-500"
        aria-label="Failed"
      />
    );
  }
  return (
    <Info
      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      aria-label="System"
    />
  );
}

/**
 * Single row + its expansion. Implemented as a `<Fragment>` so the
 * expanded panel sits in its own table row right under the trigger
 * — keeping the table grid intact.
 */
function NotificationRow({
  item,
  expanded,
  onToggle,
  tz,
}: {
  item: NotificationEntity;
  expanded: boolean;
  tz: string;
  onToggle: () => void;
}): ReactNode {
  const router = useRouter();
  const unread = item.readAt === null;
  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer",
          unread && "bg-accent/30",
        )}
        onClick={onToggle}
      >
        {/* Leading cell — chevron (collapse affordance) + status icon
            stacked inline, mirroring the RecentRuns row in
            ScheduleEditor so the two history surfaces read the same. */}
        <TableCell className="w-12 align-top">
          <div className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <KindIcon kind={item.kind} />
          </div>
        </TableCell>
        <TableCell className="w-40 whitespace-nowrap align-top text-[11px] text-muted-foreground">
          {formatTimestamp(item.createdAt, tz)}
        </TableCell>
        <TableCell className="w-64 align-top">
          {item.sourceLabel ? (
            <span className="block truncate text-xs" title={item.sourceLabel}>
              {item.sourceLabel}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="min-w-0 align-top">
          {/* Body-first: the leading status icon already conveys
              completed/failed/system, so showing the title here would
              double up. We fall back to the title only when body is
              empty (e.g. future system notifications without prose).
              When the original task is captured, surface it on its own
              line above the result so users can compare ask vs. answer
              at a glance. */}
          <div className="flex min-w-0 flex-col gap-0.5">
            {item.task && (
              <span
                className="line-clamp-1 text-xs text-muted-foreground"
                title={item.task}
              >
                <span className="mr-1 font-medium text-foreground/70">Q:</span>
                {item.task}
              </span>
            )}
            {item.body ? (
              <span
                className={cn(
                  "line-clamp-1 text-xs",
                  unread ? "font-medium" : "text-muted-foreground",
                )}
                title={item.body}
              >
                {item.task && (
                  <span className="mr-1 font-medium text-foreground/70">A:</span>
                )}
                {item.body}
              </span>
            ) : !item.task ? (
              <span
                className={cn(
                  "truncate text-xs",
                  unread ? "font-medium" : "text-muted-foreground",
                )}
                title={item.title}
              >
                {item.title}
              </span>
            ) : null}
          </div>
        </TableCell>
        <TableCell
          className="w-24 align-top text-right"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="inline-flex items-center gap-1">
            {unread && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="Mark as read"
                onClick={() => void notificationActions.markRead(item.id)}
              >
                <CheckCheck className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              title="Delete"
              onClick={() => void notificationActions.remove(item.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={5} className="px-6 py-3">
            <div className="flex flex-col gap-3">
              {item.task && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Task
                  </div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border bg-background px-3 py-2 text-xs leading-relaxed text-foreground">
                    {item.task}
                  </pre>
                </div>
              )}
              <div>
                {item.task && (
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Result
                  </div>
                )}
                {item.fullBody ? (
                  <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border bg-background px-3 py-2 text-xs leading-relaxed text-foreground">
                    {item.fullBody}
                  </pre>
                ) : item.body ? (
                  <p className="whitespace-pre-wrap text-xs text-foreground">
                    {item.body}
                  </p>
                ) : (
                  <p className="text-xs italic text-muted-foreground">
                    (no additional content)
                  </p>
                )}
              </div>
              {(item.initiator === "verification" || item.initiator === "evaluation") && (
                <div className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs font-medium hover:bg-accent/40"
                    onClick={() => {
                      if (item.initiator === "verification") {
                        router.push("/verification");
                      } else {
                        router.push("/evaluation");
                      }
                    }}
                  >
                    <span>🎯 跳转至对应套件面板</span>
                  </Button>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

export default function NotificationsPage(): ReactNode {
  // Exclude schedule notifications — those are surfaced via the
  // schedule panel's status dot, not the inbox.
  const items = useBellItems();
  const loaded = useNotificationsStore((s) => s.loaded);
  const tz = useDisplayTimezone();
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (filter === "unread") return items.filter((it) => it.readAt === null);
    if (filter === "read") return items.filter((it) => it.readAt !== null);
    if (filter === "errors")
      return items.filter((it) => it.kind === "run_failed");
    return items;
  }, [items, filter]);

  const unreadCount = useMemo(
    () => items.reduce((n, it) => n + (it.readAt === null ? 1 : 0), 0),
    [items],
  );

  return (
    <div className="flex h-full w-full flex-col px-6 py-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">
            Notifications
            <span className="text-xs font-normal text-muted-foreground ml-1.5">
              ({unreadCount > 0 ? `${unreadCount} unread` : "all caught up"})
            </span>
          </h1>
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void notificationActions.markAllRead()}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all as read
          </Button>
        )}
      </header>

      <div className="mb-3 inline-flex w-fit rounded-md border p-0.5 text-xs">
        {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded px-3 py-1 transition-colors",
              filter === f
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* `overflow-y-auto` only — never horizontal. The Context cell
          truncates and reveals the full text via inline expand, so a
          narrow viewport (left panel + right chat both open) doesn't
          force a scrollbar across the table grid. */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        <Table className="w-full table-fixed">
          <TableHeader>
            <TableRow>
              {/* No header label for the icon column — chevron + status
                  glyph are self-explanatory, matching the borderless
                  leading cells of RecentRuns. */}
              <TableHead className="w-12" />
              <TableHead className="w-40">Timestamp</TableHead>
              <TableHead className="w-64">Source</TableHead>
              <TableHead>Context</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loaded ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-xs text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-xs text-muted-foreground"
                >
                  {filter === "unread"
                    ? "No unread notifications."
                    : filter === "read"
                      ? "No read notifications."
                      : filter === "errors"
                        ? "No errors. ✨"
                        : "No notifications yet."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  tz={tz}
                  expanded={expandedId === item.id}
                  onToggle={() => {
                    setExpandedId((prev) =>
                      prev === item.id ? null : item.id,
                    );
                    // Mark as read on first expansion — implicit
                    // acknowledgement that the user has seen it.
                    if (item.readAt === null) {
                      void notificationActions.markRead(item.id);
                    }
                  }}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
