/**
 * Domain types for cached Built-in agent configuration.
 *
 * See docs/builtin-runtime.md.
 */

/** Tool-choice strategy mirroring `builtin_agent.tool_choice`. */
export type AgentToolChoice = "auto" | "required" | "none";

/** Tool-execution approval mode mirroring `builtin_agent.tool_approval_mode`. */
export type AgentToolApprovalMode = "always" | "auto" | "never";

/** CONTRACT: discriminated union mirroring `builtin_agent_tool` —
 *  keep in sync with `BuiltinAgentToolTable` in `db/schema.ts` and
 *  the `AgentToolType` union exported there. */
export type AgentToolRef =
  | { kind: "mcp_server"; mcpServerId: string }
  | { kind: "mcp_tool"; mcpServerId: string; toolName: string }
  | { kind: "skill"; skillId: string }
  | { kind: "builtin_tool"; name: string }
  | { kind: "datasource"; dataSourceId: string }
  | { kind: "ssh_server"; sshServerId: string }
  | { kind: "calendar"; calendarCredentialId: string };

import type { AgentRole } from "@/lib/db/schema";

/** Cached projection of one Built-in agent. Replaced wholesale on
 *  invalidation. */
export interface AgentSpec {
  agentId: string;
  /** Display name (mirror of `builtin_agent.name`). Cached on the
   *  spec so the dispatch / runtime / forensic-degradation paths
   *  can label an agent without re-querying the DB. */
  name: string;
  /** System-agent role (mirror of `builtin_agent.role`). `null` =
   *  regular agent. `dispatch/builtin.ts` branches on `=== "supervisor"`. */
  role: AgentRole | null;
  modelProvider: string;
  model: string;
  prompt: string | null;
  /** Pre-parsed; null = use provider default. */
  temperature: number | null;
  maxTokens: number | null;
  toolChoice: AgentToolChoice;
  toolApprovalMode: AgentToolApprovalMode;
  /** Always >= 1; defaults to 5 in schema. */
  maxSteps: number;
  /** SECURITY: decrypted LLM API key. Memory-only, never persisted /
   *  logged; invalidated whenever the credential row changes. */
  apiKey: string;
  /** Optional REST base URL for self-hosted providers (Ollama,
   *  OpenAI-compatible gateways); ignored by cloud providers. */
  restUrl: string | null;
  /** Tool bindings in display / injection order. */
  tools: AgentToolRef[];
}
