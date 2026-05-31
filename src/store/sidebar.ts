import { create } from "zustand";

/** Left-panel IDs. The *active* panel is URL-driven (see
 *  `resolveActivePanel` in `sidebar-panel-registry.tsx`); this
 *  list exists for the registry, role gating, and other tooling. */
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

/** Right-panel tab — Chat or History. */
export type RightTab = "chat" | "history";

interface SidebarState {
  // Left-panel VISIBILITY only — which panel renders is URL-driven.
  // Splitting these lets users collapse the panel while keeping
  // their section context (re-expand pops back to the URL-implied
  // panel). Not persisted; resets to true on fresh mount.

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
  // `docs/copilotkit-provider-lifecycle.md` ("URL navigation
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
