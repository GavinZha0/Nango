/**
 * Domain types for cached Built-in agent configuration.
 */

/** Tool-choice strategy mirroring `builtin_agent.tool_choice`. */
export type AgentToolChoice = "auto" | "required" | "none";

/** CONTRACT: discriminated union mirroring `builtin_agent_tool` —
 *  keep in sync with `BuiltinAgentToolTable` in `db/schema.ts` and
 *  the `AgentToolType` union exported there. */
export type AgentToolRef =
  | { kind: "mcp_server"; mcpServerId: string }
  | { kind: "mcp_tool"; mcpServerId: string; toolName: string }
  | { kind: "skill"; skillId: string }
  | { kind: "builtin_tool"; name: string }
  | { kind: "datasource"; dataSourceId: string }
  | { kind: "ssh_server"; sshServerId: string };

/** Cached projection of one Built-in agent. Replaced wholesale on
 *  invalidation. */
export interface AgentSpec {
  agentId: string;
  /** Display name (mirror of `builtin_agent.name`). Cached on the
   *  spec so the dispatch / runtime / forensic-degradation paths
   *  can label an agent without re-querying the DB. */
  name: string;
  /** Enables the supervisor tool set at runtime composition. */
  isSupervisor: boolean;
  /** One-line persona / role description; null when unauthored. */
  role: string | null;
  modelProvider: string;
  model: string;
  prompt: string | null;
  /** Pre-parsed; null = use provider default. */
  temperature: number | null;
  maxTokens: number | null;
  toolChoice: AgentToolChoice;
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
