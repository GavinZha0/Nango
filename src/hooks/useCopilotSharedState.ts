"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAgent } from "@copilotkit/react-core/v2";
import { resolveActivePanel } from "@/components/layout/sidebar-panel-registry";
import { defaultSharedState, type NangoSharedState } from "@/lib/copilot/shared-state-schema";
import { useWorkspaceStore } from "@/store/workspace";
import { useCopilotStateStore } from "@/store/copilot";
import { useValidatedFrontendTool } from "@/lib/copilot/frontend-tool-helpers";
import { z } from "zod";

/**
 * Hook to be used ONLY inside CopilotKitProvider (e.g., RightPanel).
 * It syncs URL context into the CopilotKit Agent State, and mirrors
 * the Agent State into a global Zustand store.
 */
export function useCopilotSharedStateSync() {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const { agent } = useAgent({ agentId: activeAgentId || undefined });
  const pathname = usePathname();

  const setGlobalState = useCopilotStateStore((s) => s.setState);
  const clearDraftRequest = useCopilotStateStore((s) => s.clearDraftRequest);
  const ackClearDraft = useCopilotStateStore((s) => s.ackClearDraft);
  const activeResourceData = useCopilotStateStore((s) => s.activeResourceData);

  // Infer context from URL
  const { activeUrl, activeView, activeResourceId } = useMemo(() => {
    if (!pathname) {
      return { activeUrl: "/", activeView: "none" as const, activeResourceId: null };
    }

    let panelId: NangoSharedState["context"]["activeView"] = resolveActivePanel(pathname) ?? "none";
    
    // For toolbar items that are not in the panel registry (notifications, admin routes)
    if (panelId === "none") {
      if (pathname.startsWith("/notifications")) panelId = "notifications";
      else if (pathname.startsWith("/admin/user")) panelId = "user";
      else if (pathname.startsWith("/admin/credential")) panelId = "credential";
      else if (pathname.startsWith("/admin/config")) panelId = "config";
      else if (pathname.startsWith("/admin/thread")) panelId = "thread";
    }
    
    // Extract the resource ID
    let resourceId: string | null = null;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length > 1 && panelId !== "none") {
      resourceId = parts[1];
    }

    return { activeUrl: pathname, activeView: panelId, activeResourceId: resourceId };
  }, [pathname]);

  // Sync context to Agent state
  useEffect(() => {
    if (!agent) return;
    const currentState = (agent.state as NangoSharedState) ?? defaultSharedState;
    const currentContext = currentState.context ?? defaultSharedState.context;

    if (
      currentContext.activeUrl !== activeUrl ||
      currentContext.activeView !== activeView ||
      currentContext.activeResourceId !== activeResourceId ||
      currentContext.activeResourceData !== activeResourceData
    ) {
      agent.setState({
        ...currentState,
        context: {
          ...currentContext,
          activeUrl,
          activeView,
          activeResourceId,
          activeResourceData,
        },
      });
    }
  }, [agent, activeUrl, activeView, activeResourceId, activeResourceData]);

  // Sync state from Agent -> Global Zustand Store
  useEffect(() => {
    if (!agent) return;
    const currentState = (agent.state as NangoSharedState) ?? defaultSharedState;
    setGlobalState(currentState);
  }, [agent, agent.state, setGlobalState]);

  // Handle cross-component draft clears
  useEffect(() => {
    if (clearDraftRequest && agent) {
      const currentState = (agent.state as NangoSharedState) ?? defaultSharedState;
      if (currentState.drafts && currentState.drafts[clearDraftRequest]) {
        const newState = { ...currentState, drafts: { ...currentState.drafts } };
        delete newState.drafts[clearDraftRequest];
        agent.setState(newState);
        setGlobalState(newState);
      }
      ackClearDraft();
    }
  }, [clearDraftRequest, agent, ackClearDraft, setGlobalState]);

  // Provide the update_shared_state tool to the LLM
  useValidatedFrontendTool({
    name: "update_shared_state",
    description: "Update the shared drafts state to show a preview of changes to the user on the frontend.",
    parameters: z.object({
      resourceType: z.string().describe("The type of resource being modified (e.g., 'schedule', 'workflow', 'skill')."),
      draftData: z.record(z.string(), z.unknown()).describe("The complete draft object. If the resource exists, this should be the full modified object."),
    }),
    handler: async ({ resourceType, draftData }) => {
      if (!agent) return "Agent not ready";
      const currentState = (agent.state as NangoSharedState) ?? defaultSharedState;
      const currentDrafts = currentState.drafts ?? {};
      const newState = {
        ...currentState,
        drafts: {
          ...currentDrafts,
          [resourceType]: draftData,
        },
      };
      agent.setState(newState);
      setGlobalState(newState);
      return `Draft for ${resourceType} updated successfully on the frontend.`;
    },
  });

  return null;
}

/**
 * A custom hook to be used ANYWHERE in the app (even outside CopilotKitProvider).
 * Exposes the typed state and a helper to clear drafts via Zustand.
 */
export function useCopilotSharedState() {
  const state = useCopilotStateStore((s) => s.state);
  const requestClearDraft = useCopilotStateStore((s) => s.requestClearDraft);
  const setActiveResourceData = useCopilotStateStore((s) => s.setActiveResourceData);

  return {
    state,
    drafts: state.drafts ?? {},
    clearDraft: requestClearDraft,
    setActiveResourceData,
  };
}
