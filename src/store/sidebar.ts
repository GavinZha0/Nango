import { create } from "zustand";

/**
 * Left-panel IDs — each corresponds to a panel that can be shown
 * in the collapsible left side panel next to the toolbar.
 *
 * NOTE: the *active* left panel is no longer stored here. URL is the
 * source of truth — see `resolveActivePanel(pathname)` in
 * `components/layout/sidebar-panel-registry.tsx`. The IDs are kept
 * because the registry, role gating, and other tooling key off them.
 */
export const LEFT_PANEL_IDS = [
  "dashboard",
  "artifact",
  "schedules",
  "agent",
  "mcp",
  "skills",
  "datasource",
  "ssh-server",
] as const;

export type LeftPanelId = (typeof LEFT_PANEL_IDS)[number];

/**
 * Right-panel tab — the right panel is dedicated to Chat and History.
 */
export type RightTab = "chat" | "history";

interface SidebarState {
  // Left Panel (visibility only — WHICH panel renders is URL-driven).
  //
  // This flag is purely visual. It says "should the left panel be
  // visible right now?", not "which panel". The panel component
  // itself is chosen by `resolveActivePanel(pathname)` in
  // `sidebar-panel-registry.tsx`.
  //
  // Why separate from the URL: users want to collapse the panel to
  // free up space for the main panel WITHOUT losing the section
  // context they're working in. So you can be on `/agent/<id>` with
  // the panel hidden — when you re-expand, it pops back to the
  // Agent panel because that's still what the URL says.
  //
  // Resets to `true` on every fresh mount (not persisted) — F5
  // behaviour mirrors the right panel.

  /** Whether the left panel is currently visible */
  leftPanelOpen: boolean;
  /** Toggle the left panel visibility (no URL change) */
  toggleLeftPanel: () => void;
  /** Explicitly set the left panel visibility (no URL change) */
  setLeftPanelOpen: (open: boolean) => void;

  // Right Panel (Chat)
  //
  // The right panel has no URL representation by design: chat state is
  // agent-driven, not route-driven. See
  // `docs/copilotkit-provider-lifecycle.md` §6 ("URL navigation
  // contract") for why route changes must not disturb the chat.

  /** Whether the right (Chat) panel is open */
  rightPanelOpen: boolean;
  /** Toggle the right panel open/closed */
  toggleRightPanel: () => void;
  /** Explicitly set the right panel open state */
  setRightPanelOpen: (open: boolean) => void;

  // Right Panel Tab
  /** Active tab inside the right panel */
  rightTab: RightTab;
  /** Switch the right panel tab */
  setRightTab: (tab: RightTab) => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  // Left Panel
  leftPanelOpen: true,

  toggleLeftPanel: () =>
    set({ leftPanelOpen: !get().leftPanelOpen }),

  setLeftPanelOpen: (open: boolean) =>
    set({ leftPanelOpen: open }),

  // Right Panel
  rightPanelOpen: true,

  toggleRightPanel: () =>
    set({ rightPanelOpen: !get().rightPanelOpen }),

  setRightPanelOpen: (open: boolean) =>
    set({ rightPanelOpen: open }),

  // Right Panel Tab
  rightTab: "chat",

  setRightTab: (tab: RightTab) => set({ rightTab: tab }),
}));
