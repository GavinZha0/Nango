/**
 * Shared type definitions for builtin agents.
 *
 * These were extracted from `BuiltinAgentEditor.tsx` because multiple
 * modules (stores, panels, selectors) import them. Keeping them in a
 * UI component forced those consumers to depend on the editor's barrel.
 */

import type { AgentRole } from "@/lib/db/schema";

export interface BuiltinAgentRow {
  id: string;
  /** System-agent role mirror. `null` = regular agent. */
  role?: AgentRole | null;
  /**
   * Optional emoji glyph for visual identification (e.g. "🤖", "📊").
   * Stored as the raw Unicode character. NULL means "use the default
   * glyph chosen by the renderer" (see DEFAULT_AGENT_ICON).
   */
  icon?: string | null;
  name: string;
  description: string | null;
  model: string;
  modelProvider: string;
  credentialId: string | null;
  prompt: string | null;
  temperature: string | null;
  maxTokens: number | null;
  maxSteps: number | null;
  toolChoice: string;
  memoryEnabled: boolean;
  memoryWindowSize: number | null;
  enabled: boolean;
  visibility: string;
  createdBy: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  /** Total number of tool rows attached (non-skill). */
  toolCount?: number;
  /** Number of skill-type tool rows. */
  skillCount?: number;
}

export interface BoundToolRow {
  id?: string;
  toolType: string;
  mcpServerId?: string | null;
  mcpServerName?: string | null;
  sshServerId?: string | null;
  mcpToolName?: string | null;
  skillId?: string | null;
  skillName?: string | null;
  builtinTool?: string | null;
  dataSourceId?: string | null;
}
