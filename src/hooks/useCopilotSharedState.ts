"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAgent } from "@copilotkit/react-core/v2";
import { resolveActivePanel } from "@/components/layout/sidebar-panel-registry";
import { defaultSharedState, type NangoSharedState } from "@/lib/copilot/shared-state-schema";
import { useWorkspaceStore } from "@/store/workspace";
import { useCopilotStateStore } from "@/store/copilot";
import { useValidatedFrontendTool } from "@/lib/copilot/frontend-tool-helpers";
import { normalizeResourceType } from "@/lib/copilot/resource-registry";
import { z } from "zod";

/**
 * Hook to be used ONLY inside CopilotKitProvider (e.g., RightPanel).
 * It syncs URL context into the CopilotKit Agent State, and mirrors
 * the Agent State into a global Zustand store.
 */
export function useCopilotSharedStateSync() {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const { agent } = useAgent({ agentId: activeAgentId || undefined });
  const pathname = usePathname();

  const isSupervisor = builtinAgents.find((a) => a.id === activeAgentId)?.role === "supervisor";

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
    
    // Extract the resource ID
    let resourceId: string | null = null;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length > 1 && panelId !== "none") {
      const uuidSegment = parts.find((p) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p),
      );
      resourceId = uuidSegment || parts[parts.length - 1] || null;
    }

    return { activeUrl: pathname, activeView: panelId, activeResourceId: resourceId };
  }, [pathname]);

  // Sync context to Agent state (Single Writer)
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

  // Mirror Agent State into global Zustand store (one-way mirror)
  useEffect(() => {
    if (agent?.state) {
      setGlobalState(agent.state as NangoSharedState);
    }
  }, [agent?.state, setGlobalState]);

  // Tool: propose_page_edit
  useValidatedFrontendTool({
    name: "propose_page_edit",
    available: isSupervisor,
    description: [
      "Propose changes to the resource currently open in the editor.",
      "The frontend will show a preview; the user decides whether to save.",
      "Send ONLY editable fields you want to change.",
      "Format: dates as ISO 8601 (e.g. 2025-06-15T00:00:00.000Z), cron as standard 5-field.",
      "Only works when the user is viewing an editable page with existing data.",
    ].join(" "),
    parameters: z.object({
      resourceType: z.string().describe("The type of resource being modified (e.g. 'agent', 'skills', 'schedule', 'datasource', 'ssh-server', 'mcp', 'web-auto', 'verification', 'evaluation')."),
      draftData: z.record(z.string(), z.unknown()).describe("The fields and values to modify."),
    }),
    handler: async ({ resourceType, draftData }) => {
      const editor = useCopilotStateStore.getState().activeEditor;

      // Guard: reject empty draftData (#6)
      if (!draftData || Object.keys(draftData).length === 0) {
        return "Draft data cannot be empty. Please specify the fields you want to change.";
      }

      // Guard: reject when no editor is open
      if (!editor) {
        return "No active resource editor is currently open. Ask the user to navigate to the resource editor first.";
      }

      // Normalize resourceType for comparison
      const normalizedTarget = normalizeResourceType(resourceType);
      const normalizedEditor = normalizeResourceType(editor.resourceType) ?? editor.resourceType;

      // Guard: reject resourceType mismatch (Safety Interlock against cross-page contamination)
      if (!normalizedTarget || normalizedTarget !== normalizedEditor) {
        return `Mismatch: current editor is viewing '${editor.resourceType}', but draft targets '${resourceType}'. Navigate first or use backend tools.`;
      }

      // Guard: reject read-only/builtin resources (#1)
      if (editor.isReadOnly) {
        return `Permission Denied: This ${editor.resourceType} is read-only (builtin) and cannot be edited.`;
      }

      // Apply directly to the active editor
      const appliedFields = editor.applyDraft(draftData);
      if (appliedFields.length === 0) {
        return "None of the provided fields were accepted by the editor.";
      }

      return {
        status: "success",
        resourceType: editor.resourceType,
        appliedFields,
        message: "Draft applied.",
      };
    },
  });

  // Tool: discard_page_edit
  useValidatedFrontendTool({
    name: "discard_page_edit",
    available: isSupervisor,
    description: "Discard previously proposed draft changes and restore original values in the editor.",
    parameters: z.object({
      resourceType: z.string().describe("The type of resource whose draft should be discarded."),
    }),
    handler: async ({ resourceType }) => {
      const editor = useCopilotStateStore.getState().activeEditor;
      if (!editor) {
        return `No active draft found for ${resourceType}.`;
      }
      const normalizedTarget = normalizeResourceType(resourceType);
      const normalizedEditor = normalizeResourceType(editor.resourceType) ?? editor.resourceType;
      if (!normalizedTarget || normalizedTarget !== normalizedEditor) {
        return `No active draft found for ${resourceType}. Current editor is viewing '${editor.resourceType}'.`;
      }
      editor.discardDraft();
      return `Draft changes for ${editor.resourceType} have been discarded and original values restored.`;
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
