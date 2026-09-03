"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAgent } from "@copilotkit/react-core/v2";
import { resolveActivePanel } from "@/components/layout/sidebar-panel-registry";
import { defaultSharedState, type NangoSharedState } from "@/lib/copilot/shared-state-schema";
import { useWorkspaceStore } from "@/store/workspace";
import { useCopilotStateStore } from "@/store/copilot";
import { useValidatedFrontendTool } from "@/lib/copilot/frontend-tool-helpers";
import { RESOURCE_TYPES } from "@/lib/copilot/resource-registry";
import { executeProposePageEdit, executeDiscardPageEdit } from "@/lib/copilot/tool-handlers";
import { resolveSharedStateEnabled } from "@/lib/types/builtin-agent";
import { z } from "zod";

/**
 * Hook to be used ONLY inside CopilotKitProvider (e.g., RightPanel).
 * It syncs URL context into the CopilotKit Agent State, and mirrors
 * the Agent State into a global Zustand store.
 */
export function useCopilotSharedStateSync() {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const activeAgent = builtinAgents.find((a) => a.id === activeAgentId);
  const validAgentId = activeAgent ? activeAgentId : undefined;
  const { agent } = useAgent({ agentId: validAgentId });
  const pathname = usePathname();

  const isSharedStateEnabled = resolveSharedStateEnabled(activeAgent);

  const setGlobalState = useCopilotStateStore((s) => s.setState);
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
      else if (pathname.startsWith("/trace")) panelId = "trace";
    }
    
    // Extract the resource ID (ignoring reserved creation segments)
    let resourceId: string | null = null;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length > 1 && panelId !== "none") {
      const uuidSegment = parts.find((p) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p),
      );
      const candidate = uuidSegment || parts[parts.length - 1] || null;
      if (candidate && candidate !== "new" && candidate !== "create") {
        resourceId = candidate;
      }
    }

    return { activeUrl: pathname, activeView: panelId, activeResourceId: resourceId };
  }, [pathname]);

  // Sync context to Agent state (Single Writer) - gate activeResourceData behind isSharedStateEnabled
  useEffect(() => {
    if (!agent) return;
    const currentState = (agent.state as NangoSharedState) ?? defaultSharedState;
    const currentContext = currentState.context ?? defaultSharedState.context;
    const effectiveResourceData = isSharedStateEnabled ? activeResourceData : null;

    if (
      currentContext.activeUrl !== activeUrl ||
      currentContext.activeView !== activeView ||
      currentContext.activeResourceId !== activeResourceId ||
      currentContext.activeResourceData !== effectiveResourceData
    ) {
      agent.setState({
        ...currentState,
        context: {
          ...currentContext,
          activeUrl,
          activeView,
          activeResourceId,
          activeResourceData: effectiveResourceData,
        },
      });
    }
  }, [agent, activeUrl, activeView, activeResourceId, activeResourceData, isSharedStateEnabled]);

  // Mirror Agent State into global Zustand store (one-way mirror)
  useEffect(() => {
    if (agent?.state) {
      setGlobalState(agent.state as NangoSharedState);
    }
  }, [agent?.state, setGlobalState]);

  // Tool: propose_page_edit
  useValidatedFrontendTool({
    name: "propose_page_edit",
    available: isSharedStateEnabled,
    description: [
      "Propose changes to the resource currently open in the editor.",
      "The frontend will show a preview; the user decides whether to save.",
      "Send ONLY editable fields you want to change.",
      "Format: dates as ISO 8601 (e.g. 2025-06-15T00:00:00.000Z), cron as standard 5-field.",
      "Only works when the user is viewing an editable page with existing data.",
    ].join(" "),
    parameters: z.object({
      resourceType: z.enum(RESOURCE_TYPES).describe("The exact type of resource being modified matching current URL view."),
      draftData: z.record(z.string(), z.unknown()).describe("The fields and values to modify conforming strictly to the Resource Draft Contracts in system prompt. Unknown fields are rejected."),
    }),
    handler: async ({ resourceType, draftData }) => {
      return executeProposePageEdit({ resourceType, draftData });
    },
  });

  // Tool: discard_page_edit
  useValidatedFrontendTool({
    name: "discard_page_edit",
    available: isSharedStateEnabled,
    description: "Discard previously proposed draft changes and restore original values in the editor.",
    parameters: z.object({
      resourceType: z.enum(RESOURCE_TYPES).describe("The exact type of resource whose draft should be discarded."),
    }),
    handler: async ({ resourceType }) => {
      return executeDiscardPageEdit({ resourceType });
    },
  });

  return null;
}

/**
 * A custom hook to access shared context data.
 */
export function useCopilotSharedState() {
  const state = useCopilotStateStore((s) => s.state);
  const setActiveResourceData = useCopilotStateStore((s) => s.setActiveResourceData);

  return {
    state,
    setActiveResourceData,
  };
}
