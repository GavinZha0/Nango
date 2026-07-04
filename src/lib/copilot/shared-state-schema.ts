/**
 * Nango Shared State Schema
 * Defines the structure for bidirectional state sharing between the React frontend
 * and the CopilotKit Built-in Agent.
 */

export interface NangoSharedState {
  /**
   * 1. Context Injection (Frontend -> Agent)
   * The frontend updates this when the user navigates across panels.
   * Gives the Agent ambient awareness of what the user is currently looking at.
   */
  context: {
    activeUrl: string;
    activeView: 
      | "dashboard" | "artifact" | "schedules" | "notifications"
      | "agent" | "mcp" | "skills" | "datasource" | "ssh-server" 
      | "verification" | "evaluation" | "outcomes" | "profile"
      | "user" | "credential" | "config" | "trace" 
      | "none";
    activeResourceId?: string | null;
    activeResourceData?: Record<string, unknown> | null; // A readonly copy of the data to give the agent context
  };

  /**
   * 2. Drafts (Agent -> Frontend)
   * When the agent decides to use "Copilot Mode" (interactive modification),
   * it writes proposed changes here instead of calling DB tools directly.
   * Frontend components react to this to show previews/diffs.
   */
  drafts: {
    schedule?: Record<string, unknown>;
    skill?: Record<string, unknown>;
    workflow?: {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    // Add other resource types as needed
    [key: string]: Record<string, unknown> | undefined;
  };

}

export const defaultSharedState: NangoSharedState = {
  context: {
    activeUrl: "/",
    activeView: "none",
    activeResourceId: null,
    activeResourceData: null,
  },
  drafts: {},
};
