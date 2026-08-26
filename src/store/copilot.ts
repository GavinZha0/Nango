import { create } from "zustand";
import { defaultSharedState, type NangoSharedState } from "@/lib/copilot/shared-state-schema";

export interface EditorRegistration {
  instanceId: string;
  resourceType: string;
  resourceId: string | null;
  isReadOnly: boolean;
  applyDraft: (draft: Record<string, unknown>) => string[];
  getCurrentData: () => Record<string, unknown>;
  discardDraft: () => void;
}

interface CopilotStateStore {
  state: NangoSharedState;
  setState: (s: NangoSharedState) => void;
  activeResourceData: Record<string, unknown> | null;
  setActiveResourceData: (data: Record<string, unknown> | null) => void;

  activeEditor: EditorRegistration | null;
  registerEditor: (editor: EditorRegistration) => void;
  unregisterEditor: (instanceId: string) => void;
}

export const useCopilotStateStore = create<CopilotStateStore>((set) => ({
  state: defaultSharedState,
  setState: (s) => set({ state: s }),
  activeResourceData: null,
  setActiveResourceData: (data) => set({ activeResourceData: data }),

  activeEditor: null,
  registerEditor: (editor) => set({ activeEditor: editor }),
  unregisterEditor: (instanceId) =>
    set((s) => (s.activeEditor?.instanceId === instanceId ? { activeEditor: null } : {})),
}));

// Expose store to window for debugging (only in development)
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  (window as unknown as { __NANGO_COPILOT_STORE__?: typeof useCopilotStateStore }).__NANGO_COPILOT_STORE__ = useCopilotStateStore;
}
