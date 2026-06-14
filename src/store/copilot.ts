import { create } from "zustand";
import { defaultSharedState, type NangoSharedState } from "@/lib/copilot/shared-state-schema";

interface CopilotStateStore {
  state: NangoSharedState;
  setState: (s: NangoSharedState) => void;
  clearDraftRequest: string | null;
  requestClearDraft: (resourceType: string) => void;
  ackClearDraft: () => void;
  activeResourceData: Record<string, unknown> | null;
  setActiveResourceData: (data: Record<string, unknown> | null) => void;
}

export const useCopilotStateStore = create<CopilotStateStore>((set) => ({
  state: defaultSharedState,
  setState: (s) => set({ state: s }),
  clearDraftRequest: null,
  requestClearDraft: (resourceType) => set({ clearDraftRequest: resourceType }),
  ackClearDraft: () => set({ clearDraftRequest: null }),
  activeResourceData: null,
  setActiveResourceData: (data) => set({ activeResourceData: data }),
}));
