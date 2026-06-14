"use client";

/**
 * LeftToolbar — fixed-width vertical icon toolbar on the far left.
 */

import type { ReactNode, ComponentType } from "react";
import { Fragment } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Users,
  KeyRound,
  Settings,
  BellRing,
  BoomBox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { LeftPanelId } from "@/store/sidebar";
import { useSidebarStore } from "@/store/sidebar";
import { SIDEBAR_PANEL_REGISTRY } from "@/components/layout/sidebar-panel-registry";
import { useRole } from "@/hooks/useRole";
import {
  selectUnreadCount,
  selectHasUnreadSchedule,
  selectHasScheduleFailure,
  useNotificationsStore,
} from "@/store/notifications";
import { notificationActions } from "@/hooks/useNotifications";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Toolbar item declaration

type Role = "user" | "editor" | "admin";
type Icon = ComponentType<{ className?: string }>;

interface ToolbarPanelItem {
  kind: "panel";
  id: LeftPanelId;
  /** undefined = visible to user (no role gate) */
  role?: Role;
}
interface ToolbarRouteItem {
  kind: "route";
  id: string;
  label: string;
  icon: Icon;
  href: string;
  role?: Role;
}
interface ToolbarNotificationsItem {
  kind: "notifications";
  role?: Role;
}
type ToolbarItem =
  | ToolbarPanelItem
  | ToolbarRouteItem
  | ToolbarNotificationsItem;

/** Toolbar contents + ordering. Grouped visually by role; declaration order = render order. */
const TOOLBAR_ITEMS: ToolbarItem[] = [
  // User group
  { kind: "panel", id: "dashboard" },
  { kind: "panel", id: "artifact" },
  { kind: "panel", id: "schedules" },
  { kind: "notifications" },

  // Editor group
  { kind: "panel", id: "agent", role: "editor" },
  { kind: "panel", id: "mcp", role: "editor" },
  { kind: "panel", id: "skills", role: "editor" },
  { kind: "panel", id: "datasource", role: "editor" },
  { kind: "panel", id: "ssh-server", role: "editor" },
  { kind: "panel", id: "verification", role: "editor" },
  { kind: "panel", id: "evaluation", role: "editor" },

  // Admin group
  { kind: "route", id: "user", label: "Users", icon: Users, href: "/admin/user", role: "admin" },
  { kind: "route", id: "credential", label: "Credentials", icon: KeyRound, href: "/admin/credential", role: "admin" },
  { kind: "route", id: "config", label: "Config", icon: Settings, href: "/admin/config", role: "admin" },
  { kind: "route", id: "thread", label: "Threads", icon: BoomBox, href: "/admin/thread", role: "admin" },
];

/** Resolve the effective role for an item (default = "user"). */
function effectiveRole(item: ToolbarItem): Role {
  return item.role ?? "user";
}

// Component

export function LeftToolbar(): ReactNode {
  const pathname = usePathname();
  const router = useRouter();
  const setLeftPanelOpen = useSidebarStore((s) => s.setLeftPanelOpen);
  const toggleLeftPanel = useSidebarStore((s) => s.toggleLeftPanel);
  const { isAdmin, isEditor } = useRole();
  const unreadCount = useNotificationsStore(selectUnreadCount);
  const hasUnreadSchedule = useNotificationsStore(selectHasUnreadSchedule);
  const hasScheduleFailure = useNotificationsStore(selectHasScheduleFailure);
  const isOnNotificationsRoute = pathname.startsWith("/notifications");

  // Filter by role, then group by role for visual segmentation.
  const visibleItems = TOOLBAR_ITEMS.filter((item) => {
    const role = effectiveRole(item);
    if (role === "user") return true;
    if (role === "editor") return isEditor;
    return isAdmin;
  });
  const groups = groupByRole(visibleItems);

  // Panel toolbar clicks have two flavours:
  //   - Different section → navigate (URL changes) AND force the
  //     panel visible in case the user had collapsed it earlier.
  //   - Same section → toggle the panel's visibility flag (purely
  //     visual, URL unchanged). This matches the mental model of
  //     "show/hide the panel" without leaving the work context —
  //     repeat-clicking the same toolbar icon should not navigate
  //     away from /agent/<id>.
  function handlePanelClick(id: LeftPanelId) {
    const def = SIDEBAR_PANEL_REGISTRY[id];
    const alreadyActive = pathname.startsWith(def.href);
    if (alreadyActive) {
      toggleLeftPanel();
    } else {
      router.push(def.href);
      setLeftPanelOpen(true);
    }
    if (id === "schedules") {
      void notificationActions.markScheduleRead();
    }
  }

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-full w-12 flex-shrink-0 flex-col items-center border-r bg-background py-2">
        {groups.map((group, gi) => (
          <Fragment key={`g-${gi}`}>
            {gi > 0 && <div className="my-2 h-px w-6 bg-border" />}
            <nav className="flex flex-col items-center gap-1">
              {group.map((item) => renderItem(item, {
                pathname,
                isOnNotificationsRoute,
                unreadCount,
                hasUnreadSchedule,
                hasScheduleFailure,
                onPanel: handlePanelClick,
                onRoute: (href: string) => router.push(href),
              }))}
            </nav>
          </Fragment>
        ))}

        {/* Spacer keeps the bottom of the toolbar free for future
            footer content (currently nothing — user menu lives in
            Header). */}
        <div className="flex-1" />
      </div>
    </TooltipProvider>
  );
}

// Helpers

interface RenderContext {
  pathname: string;
  isOnNotificationsRoute: boolean;
  unreadCount: number;
  hasUnreadSchedule: boolean;
  hasScheduleFailure: boolean;
  onPanel: (id: LeftPanelId) => void;
  onRoute: (href: string) => void;
}

function renderItem(item: ToolbarItem, ctx: RenderContext): ReactNode {
  if (item.kind === "panel") return renderPanel(item, ctx);
  if (item.kind === "route") return renderRoute(item, ctx);
  return renderNotifications(item, ctx);
}

function renderPanel(item: ToolbarPanelItem, ctx: RenderContext): ReactNode {
  const def = SIDEBAR_PANEL_REGISTRY[item.id];
  const Icon = def.icon;
  // `startsWith` so the highlight stays on while a detail page is
  // open (`/agent/<id>` keeps the Agent button lit). Matches the
  // `renderRoute` convention.
  const active = ctx.pathname.startsWith(def.href);

  // Schedule status dot: green = recent run succeeded, amber = failed.
  const showScheduleDot =
    item.id === "schedules" && ctx.hasUnreadSchedule;
  const scheduleDotColor = ctx.hasScheduleFailure
    ? "bg-amber-500"
    : "bg-emerald-500";

  return (
    <Tooltip key={`panel-${item.id}`}>
      <TooltipTrigger
        onClick={() => ctx.onPanel(item.id)}
        className={cn(
          "relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-md transition-colors",
          active
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
        aria-label={def.label}
        aria-pressed={active}
      >
        <Icon className="h-6 w-6" />
        {showScheduleDot && (
          <span
            className={cn(
              "absolute right-1 top-1 h-2 w-2 rounded-full",
              scheduleDotColor,
            )}
          />
        )}
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{def.label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function renderRoute(item: ToolbarRouteItem, ctx: RenderContext): ReactNode {
  const Icon = item.icon;
  const active = ctx.pathname.startsWith(item.href);
  return (
    <Tooltip key={`route-${item.id}`}>
      <TooltipTrigger
        onClick={() => ctx.onRoute(item.href)}
        className={cn(
          "flex h-9 w-9 cursor-pointer items-center justify-center rounded-md transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
        aria-label={item.label}
      >
        <Icon className="h-6 w-6" />
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{item.label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function renderNotifications(
  _item: ToolbarNotificationsItem,
  ctx: RenderContext,
): ReactNode {
  return (
    <Tooltip key="notifications">
      <TooltipTrigger
        onClick={() => ctx.onRoute("/notifications")}
        className={cn(
          "relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-md transition-colors",
          ctx.isOnNotificationsRoute
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
        aria-label="Notifications"
      >
        <BellRing className="h-6 w-6" />
        {ctx.unreadCount > 0 && (
          <span className="absolute right-0.5 top-0.5 inline-flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white">
            {ctx.unreadCount > 99 ? "99+" : ctx.unreadCount}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>Notifications</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Group consecutive items of the same role into segments. We don't
 * sort — TOOLBAR_ITEMS is already authored in role order — so this
 * is just a fold that pushes each item into its current group and
 * starts a new one whenever the role changes.
 */
function groupByRole(items: ToolbarItem[]): ToolbarItem[][] {
  const groups: ToolbarItem[][] = [];
  let lastRole: Role | null = null;
  for (const item of items) {
    const role = effectiveRole(item);
    if (role !== lastRole) {
      groups.push([]);
      lastRole = role;
    }
    groups[groups.length - 1].push(item);
  }
  return groups;
}
