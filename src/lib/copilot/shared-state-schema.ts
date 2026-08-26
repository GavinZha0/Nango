/**
 * Nango Shared State Schema
 * Defines the structure for bidirectional state sharing between the React frontend
 * and the CopilotKit Built-in Agent.
 */

export interface NangoSharedState {
  /**
   * Context Injection (Frontend -> Agent)
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
      | "none" | "web-auto";
    activeResourceId: string | null;
    activeResourceData?: Record<string, unknown> | null;
  };
}

export const defaultSharedState: NangoSharedState = {
  context: {
    activeUrl: "/",
    activeView: "none",
    activeResourceId: null,
    activeResourceData: null,
  },
};
