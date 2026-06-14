import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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
  "verification",
  "evaluation",
] as const;

export type LeftPanelId = (typeof LEFT_PANEL_IDS)[number];

/** Right-panel tab — Chat or History. */
export type RightTab = "chat" | "history";

interface SidebarState {
  // Hydration flag — true once Zustand persist has restored state
  // from localStorage. Components that depend on persisted values
  // (e.g. panel open/close) should gate rendering on this to avoid
  // flash-of-wrong-state on page refresh.

  /** True after persist middleware has restored state from localStorage */
  hydrated: boolean;

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

  // History refresh — bumped by the toolbar refresh button,
  // observed by HistoryPanelContent to re-fetch threads.
  historyRevision: number;
  bumpHistoryRevision: () => void;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      // Hydration — flipped to true by onRehydrateStorage below
      hydrated: false,

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

      // Right Panel Tab (not persisted — always opens to chat)
      rightTab: "chat",

      setRightTab: (tab: RightTab) => set({ rightTab: tab }),

      // History refresh (not persisted)
      historyRevision: 0,
      bumpHistoryRevision: () =>
        set((s) => ({ historyRevision: s.historyRevision + 1 })),
    }),
    {
      name: "nango:sidebar",
      // SSR guard: localStorage is not available on the server.
      storage: createJSONStorage(() =>
        typeof window !== "undefined"
          ? localStorage
          : (undefined as never),
      ),
      // Only persist the two panel visibility flags.
      // Actions (functions) are excluded automatically.
      // rightTab is intentionally omitted — chat is always the default.
      partialize: (state) => ({
        leftPanelOpen: state.leftPanelOpen,
        rightPanelOpen: state.rightPanelOpen,
      }),
    },
  ),
);

// Flip hydrated flag once persist has restored from localStorage.
// `onFinishHydration` is always called — even when storage is empty
// or unavailable — so the flag is guaranteed to become true on the
// client.
if (typeof window !== "undefined") {
  const unsub = useSidebarStore.persist.onFinishHydration(() => {
    useSidebarStore.setState({ hydrated: true });
    unsub();
  });
  // If hydration already finished synchronously before the listener
  // was attached (possible with sync storage like localStorage):
  if (useSidebarStore.persist.hasHydrated()) {
    useSidebarStore.setState({ hydrated: true });
  }
}
