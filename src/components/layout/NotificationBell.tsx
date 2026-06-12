"use client";

/**
 * NotificationBell — header dropdown showing recent notifications.
 */

import type { ReactNode } from "react";
import {
  AlertTriangle,
  BellRing,
  BellOff,
  CheckCheck,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  useNotificationsStore,
  selectUnreadCount,
} from "@/store/notifications";
import { notificationActions } from "@/hooks/useNotifications";
import type { NotificationEntity } from "@/lib/db/schema";

/** Dropdown preview row limit. Overflow goes to "View all" page. */
const PREVIEW_LIMIT = 6;

function timeAgo(iso: string | Date): string {
  const t = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Lead with a coloured status glyph so the row's outcome is legible
 * at a glance — green check for success, red X for failure, amber
 * warning for anything else (system / unknown). The heading text
 * after the icon is the *source* of the notification (e.g. the
 * delegated agent's display name), not a generic phrase like
 * "Async task completed" — that information is already conveyed by
 * the icon's colour.
 */
function StatusIcon({ kind }: { kind: string }): ReactNode {
  if (kind === "run_completed") {
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 shrink-0 text-emerald-500"
        aria-label="Completed"
      />
    );
  }
  if (kind === "run_failed") {
    return (
      <XCircle
        className="h-3.5 w-3.5 shrink-0 text-red-500"
        aria-label="Failed"
      />
    );
  }
  return (
    <AlertTriangle
      className="h-3.5 w-3.5 shrink-0 text-amber-500"
      aria-label="Notice"
    />
  );
}

function NotificationRow({
  item,
}: {
  item: NotificationEntity;
}): ReactNode {
  const unread = item.readAt === null;
  // Heading line is the source — falls back to the title only when
  // we genuinely don't know where it came from (e.g. recovery-time
  // sweeps that pre-date sourceLabel).
  const heading = item.sourceLabel ?? item.title;
  // Outer is a `div` styled as a button so the row is clickable for
  // mark-as-read and keyboard-accessible via Enter / Space.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void notificationActions.markRead(item.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void notificationActions.markRead(item.id);
        }
      }}
      className={cn(
        "group flex flex-col gap-0.5 px-3 py-2 text-left transition-colors cursor-pointer focus-visible:outline-none",
        unread ? "bg-accent/30 hover:bg-accent/50" : "hover:bg-accent/30",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon kind={item.kind} />
        <span
          className={cn(
            "flex-1 truncate text-xs",
            unread ? "font-medium" : "text-muted-foreground",
          )}
          title={heading}
        >
          {heading}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {timeAgo(item.createdAt)}
        </span>
      </div>
      {item.body && (
        <p className="line-clamp-2 pl-[1.375rem] text-[11px] text-muted-foreground">
          {item.body}
        </p>
      )}
    </div>
  );
}

export function NotificationBell(): ReactNode {
  const items = useNotificationsStore((s) => s.items);
  const isStreamConnected = useNotificationsStore((s) => s.isStreamConnected);
  const unreadCount = useNotificationsStore(selectUnreadCount);

  // Show all unread first, then fill with read up to PREVIEW_LIMIT.
  const recent = items.slice(0, PREVIEW_LIMIT);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : "Notifications"
        }
      >
        {isStreamConnected ? (
          <BellRing className="h-4 w-4" />
        ) : (
          <BellOff className="h-4 w-4" />
        )}
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="end"
        className="w-80 p-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Notifications
          </span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void notificationActions.markAllRead()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </button>
          )}
        </div>

        {/* Body — no scroll. PREVIEW_LIMIT bounds the row count, so
            the dropdown grows naturally and never shows a scrollbar. */}
        <div>
          {recent.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No notifications yet.
            </p>
          ) : (
            recent.map((item) => (
              <NotificationRow key={item.id} item={item} />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-3 py-1.5 text-right">
          <Link
            href="/notifications"
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            View all
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
