"use client";

/**
 * Header — top-level horizontal header bar.
 */

import { useSyncExternalStore, type ReactNode, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Bot, FlaskConical, Medal, MessagesSquare, LogOut, UserRound, ChevronDown, Sun, Moon } from "lucide-react";
import { useActiveTasksStore, type ActiveTask } from "@/store/active-tasks";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth/client";
import { useSidebarStore } from "@/store/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NotificationBell } from "@/components/layout/NotificationBell";

// User helpers

function getUserName(user: { name?: string | null } | undefined): string {
  return user?.name ?? "Unknown";
}

function getUserInitial(name: string): string {
  return name[0]?.toUpperCase() ?? "?";
}

// Sub-components

function NotificationBar(): ReactNode {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center px-4">
      {/* Placeholder — will show notifications, schedule alerts, errors */}
    </div>
  );
}

function UserMenu(): ReactNode {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const userName = getUserName(user);
  const userInitial = getUserInitial(userName);

  async function handleSignOut(): Promise<void> {
    await authClient.signOut();
    window.location.href = "/sign-in";
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="group flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent"
        aria-label="Open user menu"
      >
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground select-none">
          {userInitial}
        </div>
        <span className="hidden text-sm font-medium text-foreground sm:inline">
          {userName}
        </span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent side="bottom" align="end" className="w-40">
        <DropdownMenuItem onClick={() => router.push("/profile")}>
          <UserRound className="h-4 w-4" />
          <span>Profile</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void handleSignOut()}>
          <LogOut className="h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * useIsClient — SSR-safe "are we on the client yet?" signal.
 *
 * Uses `useSyncExternalStore` with distinct server/client snapshots so the
 * value is `false` during SSR and on the hydration render, then flips to
 * `true` on the first post-commit render. This avoids the lint rule against
 * `useEffect(() => setState(true), [])` while still giving us a clean
 * mount-detection hook.
 */
function useIsClient(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * ThemeToggleButton — flips between light and dark themes via next-themes.
 *
 * Hydration: `next-themes` resolves the active theme synchronously on the
 * client (an inline head script reads `localStorage` before React hydrates),
 * which means the very first client render already sees the real theme while
 * SSR rendered with `undefined`. To avoid a hydration mismatch, we render a
 * theme-agnostic placeholder until `useIsClient()` flips, then swap in the
 * real toggle. The placeholder has the same dimensions so the header layout
 * does not shift.
 */
function ThemeToggleButton(): ReactNode {
  const isClient: boolean = useIsClient();
  const { resolvedTheme, setTheme } = useTheme();

  if (!isClient) {
    return (
      <span
        aria-hidden
        className="inline-flex h-8 w-8 items-center justify-center"
      />
    );
  }

  const isDark: boolean = resolvedTheme === "dark";
  const nextTheme: "dark" | "light" = isDark ? "light" : "dark";
  const label: string = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={() => setTheme(nextTheme)}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        )}
        aria-label={label}
      >
        {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ChatToggleButton(): ReactNode {
  const rightPanelOpen = useSidebarStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useSidebarStore((s) => s.toggleRightPanel);

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={toggleRightPanel}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          rightPanelOpen
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        )}
        aria-label="Toggle chat panel"
        aria-pressed={rightPanelOpen}
      >
        <MessagesSquare className="h-4 w-4" />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{rightPanelOpen ? "Close chat" : "Open chat"}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const KIND_ICON: Record<ActiveTask["kind"], React.ComponentType<{ className?: string }>> = {
  agent: Bot,
  verification: FlaskConical,
  evaluation: Medal,
};

function BadgeVariant({ task, progressText }: { task: ActiveTask; progressText: string }) {
  const router = useRouter();
  const toggleRightPanel = useSidebarStore((s) => s.toggleRightPanel);
  const setLeftPanelOpen = useSidebarStore((s) => s.setLeftPanelOpen);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (task.kind === "agent") {
      toggleRightPanel();
    } else if (task.kind === "verification") {
      router.push("/verification");
      setLeftPanelOpen(true);
    } else if (task.kind === "evaluation") {
      router.push("/evaluation");
      setLeftPanelOpen(true);
    }
  };

  const isRunning = task.status === "running";
  const TypeIcon = KIND_ICON[task.kind];

  let iconClass = "h-3.5 w-3.5 shrink-0";
  let borderClass = "";
  let labelClass = "text-foreground";
  if (isRunning) {
    iconClass = cn(iconClass, "text-primary");
    borderClass = "border-primary/30";
    labelClass = "text-primary";
  } else if (task.status === "succeeded") {
    iconClass = cn(iconClass, "text-emerald-600 dark:text-emerald-400");
  } else if (task.status === "failed") {
    iconClass = cn(iconClass, "text-red-600 dark:text-red-400");
  }

  const label = task.name.replace(/^(builtin|backend)[:/]/i, "").trim();

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "inline-flex cursor-pointer select-none items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 transition-all hover:bg-accent",
        borderClass
      )}
    >
      <TypeIcon className={iconClass} />
      <div className="flex flex-col items-start leading-none">
        <span className={cn("text-xs font-medium", labelClass)}>{label}</span>
        {progressText && (
          <span className="mt-0.5 text-[10px] text-muted-foreground">{progressText}</span>
        )}
      </div>
    </button>
  );
}

function AgentBadge({ task }: { task: ActiveTask }) {
  const [elapsed, setElapsed] = useState(() => {
    const started = new Date(task.startedAt).getTime();
    const diff = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  });

  useEffect(() => {
    if (task.status !== "running") {
      return;
    }

    const started = new Date(task.startedAt).getTime();
    const update = () => {
      const diff = Math.max(0, Math.floor((Date.now() - started) / 1000));
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setElapsed(`${m}:${s.toString().padStart(2, "0")}`);
    };

    update();
    const timer = setInterval(update, 10000);
    return () => clearInterval(timer);
  }, [task.startedAt, task.status]);

  return <BadgeVariant task={task} progressText={elapsed} />;
}

function SuiteBadge({ task }: { task: ActiveTask }) {
  const text =
    typeof task.totalCount === "number"
      ? `${task.completedCount ?? 0}/${task.totalCount ?? 0}`
      : "";
  return <BadgeVariant task={task} progressText={text} />;
}

function ActiveTasksIndicators(): ReactNode {
  const activeTasks = useActiveTasksStore((s) => s.activeTasks);

  if (activeTasks.length === 0) return null;

  const renderList = activeTasks.slice(0, 5);

  return (
    <div className="flex items-center gap-1.5">
      {renderList.map((task) => {
        if (task.kind === "agent") {
          return <AgentBadge key={task.id} task={task} />;
        }
        return <SuiteBadge key={task.id} task={task} />;
      })}
      {activeTasks.length > 5 && (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          +{activeTasks.length - 5}
        </Badge>
      )}
    </div>
  );
}

// Header

export function Header(): ReactNode {
  return (
    <header className="flex h-12 flex-shrink-0 items-center border-b bg-background px-3">
      {/* Left: Logo + product name */}
      <Link
        href="/"
        className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-accent"
      >
        <Image
          src="/logo.png"
          alt="Nango logo"
          width={24}
          height={24}
          className="flex-shrink-0 rounded-sm"
        />
        <span className="text-sm font-bold tracking-tight text-foreground">
          Nango
        </span>
      </Link>

      {/* Center: notifications / alerts */}
      <NotificationBar />

      {/* Right: theme + notifications | user menu + chat toggle */}
      <div className="flex items-center gap-1">
        <ActiveTasksIndicators />
        <span aria-hidden className="mx-1 h-5 w-px bg-border/70" />
        <NotificationBell />
        <ThemeToggleButton />
        {/* Vertical divider — separates the notifications cluster
            from the identity / chat-toggle cluster. */}
        <span aria-hidden className="mx-1 h-5 w-px bg-border/70" />
        <UserMenu />
        <ChatToggleButton />
      </div>
    </header>
  );
}
