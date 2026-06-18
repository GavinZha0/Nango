"use client";

import { useEffect, useMemo, useRef } from "react";
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
      else if (pathname.startsWith("/outcomes")) panelId = "outcomes";
      else if (pathname.startsWith("/profile")) panelId = "profile";
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

  // Clear drafts when the active agent changes to prevent stale state.
  const prevAgentIdRef = useRef(activeAgentId);
  useEffect(() => {
    if (prevAgentIdRef.current !== activeAgentId) {
      prevAgentIdRef.current = activeAgentId;
      if (agent) {
        const cleared = { ...defaultSharedState, context: (agent.state as NangoSharedState)?.context ?? defaultSharedState.context };
        agent.setState(cleared);
        setGlobalState(cleared);
      }
    }
  }, [activeAgentId, agent, setGlobalState]);

  /** Constrained resource types that support draft editing. */
  const draftResourceTypes = z.enum(["schedule", "workflow", "skill", "agent", "datasource", "ssh-server", "mcp"]);

  /** Map activeView → accepted resourceType so we can detect mismatches. */
  const viewToResource: Record<string, string> = {
    schedules: "schedule",
    artifact: "workflow",
    skills: "skill",
    agent: "agent",
    datasource: "datasource",
    "ssh-server": "ssh-server",
    mcp: "mcp",
  };

  // Tool: propose_page_edit
  useValidatedFrontendTool({
    name: "propose_page_edit",
    description: [
      "Propose changes to the resource currently open in the editor.",
      "The frontend will show a preview; the user decides whether to save.",
      "Send the FULL modified object (replace, not merge).",
      "Format: dates as ISO 8601 (e.g. 2025-06-15T00:00:00.000Z), cron as standard 5-field.",
      "Only works when the user is viewing an editable page with existing data.",
    ].join(" "),
    parameters: z.object({
      resourceType: draftResourceTypes.describe("The type of resource being modified."),
      draftData: z.record(z.string(), z.unknown()).describe("The complete draft object with all fields."),
    }),
    handler: async ({ resourceType, draftData }) => {
      if (!agent) return "Agent not ready.";
      const rt: string = resourceType;
      // Guard: reject when the page has no editable data
      if (!activeResourceData) {
        return "Current page has no editable data. Use backend tools or ask the user to navigate to the resource editor.";
      }
      // Guard: reject resourceType / activeView mismatch
      const expectedResource = viewToResource[activeView];
      if (expectedResource && expectedResource !== rt) {
        return `Mismatch: user is viewing ${activeView} but draft targets ${rt}. Navigate first or use backend tools.`;
      }
      const currentState = (agent.state as NangoSharedState) ?? defaultSharedState;
      const newState = {
        ...currentState,
        drafts: { ...currentState.drafts, [rt]: draftData },
      };
      agent.setState(newState);
      setGlobalState(newState);
      return `Draft for ${rt} proposed. The user will review and save.`;
    },
  });

  // Tool: discard_page_edit
  useValidatedFrontendTool({
    name: "discard_page_edit",
    description: "Discard a previously proposed draft for a resource type.",
    parameters: z.object({
      resourceType: draftResourceTypes.describe("The type of resource whose draft should be discarded."),
    }),
    handler: async ({ resourceType }) => {
      if (!agent) return "Agent not ready.";
      const rt: string = resourceType;
      const currentState = (agent.state as NangoSharedState) ?? defaultSharedState;
      if (!currentState.drafts?.[rt]) {
        return `No draft found for ${rt}.`;
      }
      const newDrafts = { ...currentState.drafts };
      delete newDrafts[rt];
      const newState = { ...currentState, drafts: newDrafts };
      agent.setState(newState);
      setGlobalState(newState);
      return `Draft for ${rt} discarded.`;
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
