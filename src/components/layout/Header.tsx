"use client";

/**
 * Header — top-level horizontal header bar.
 */

import { useSyncExternalStore, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  MessagesSquare,
  LogOut,
  UserRound,
  Settings,
  ChevronDown,
  Sun,
  Moon,
} from "lucide-react";
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
  const userEmail = user?.email ?? "";

  async function handleSignOut(): Promise<void> {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
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

      <DropdownMenuContent side="bottom" align="end" className="w-56">
        <DropdownMenuItem disabled className="flex-col items-start gap-0.5 py-2">
          <p className="truncate text-sm font-medium text-foreground">{userName}</p>
          <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/profile")}>
          <UserRound className="h-4 w-4" />
          <span>Profile</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Settings className="h-4 w-4" />
          <span>Preferences</span>
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
        <ThemeToggleButton />
        <NotificationBell />
        {/* Vertical divider — separates the notifications cluster
            from the identity / chat-toggle cluster. */}
        <span aria-hidden className="mx-1 h-5 w-px bg-border/70" />
        <UserMenu />
        <ChatToggleButton />
      </div>
    </header>
  );
}
