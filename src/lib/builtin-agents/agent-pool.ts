/**
 * Process-wide cache of Built-in agent specifications.
 *
 * See docs/builtin-runtime.md.
 */

import "server-only";

import { LRUCache } from "lru-cache";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  BuiltinAgentToolTable,
  type AgentToolType,
} from "@/lib/db/schema";
import { getCredentialConfigById } from "@/lib/credentials/lookup";

import type { AgentSpec, AgentToolChoice, AgentToolRef } from "./agent-spec";

export interface AgentPoolOptions {
  /** Max entries; protects against pathological agent-row growth. */
  max?: number;
  /** Time-bounded freshness (ms). */
  ttl?: number;
  /** Loader override for tests. */
  load?: AgentSpecLoader;
}

/** CONTRACT: returns null when the agent is missing, disabled, or
 *  has an unresolvable credential. */
export type AgentSpecLoader = (agentId: string) => Promise<AgentSpec | null>;

import { getConfigMs, getConfigNumber } from "@/lib/config";

const DEFAULT_MAX: number = 500;
const DEFAULT_TTL_S: number = 600;

export class AgentPool {
  private readonly cache: LRUCache<string, AgentSpec>;
  private readonly load: AgentSpecLoader;

  constructor(opts: AgentPoolOptions = {}) {
    this.load = opts.load ?? defaultLoadAgentSpec;
    this.cache = new LRUCache<string, AgentSpec>({
      max: opts.max ?? getConfigNumber("cache.agent_pool.max", DEFAULT_MAX),
      ttl: opts.ttl ?? getConfigMs("cache.agent_pool.ttl", DEFAULT_TTL_S),
      fetchMethod: async (key: string): Promise<AgentSpec | undefined> => {
        // `lru-cache`'s fetchMethod rejects `null` as a value — null
        // misses get stored as `undefined` (i.e. cache miss).
        const spec: AgentSpec | null = await this.load(key);
        return spec ?? undefined;
      },
    });
  }

  /** CONTRACT: returns null when missing / disabled / unresolvable. */
  async get(agentId: string): Promise<AgentSpec | null> {
    const spec: AgentSpec | undefined = await this.cache.fetch(agentId);
    return spec ?? null;
  }

  /** Drop a single entry on agent CRUD. */
  invalidate(agentId: string): void {
    this.cache.delete(agentId);
  }

  /** SECURITY: drop every cached spec whose row references
   *  `credentialId` so a stale decrypted apiKey can never serve
   *  another request. Cost scales with agents bound to the credential,
   *  not cache size. */
  async invalidateByCredential(credentialId: string): Promise<void> {
    const rows: Array<{ id: string }> = await db
      .select({ id: BuiltinAgentTable.id })
      .from(BuiltinAgentTable)
      .where(eq(BuiltinAgentTable.credentialId, credentialId));
    for (const row of rows) {
      this.cache.delete(row.id);
    }
  }

  /** Panic button — reserved for migrations. */
  invalidateAll(): void {
    this.cache.clear();
  }

  // Test helpers (underscore-prefixed; not part of the contract)

  _size(): number {
    return this.cache.size;
  }

  _has(agentId: string): boolean {
    return this.cache.has(agentId);
  }
}

// Default loader

interface AgentRow {
  id: string;
  name: string;
  isSupervisor: boolean;
  role: string | null;
  modelProvider: string;
  model: string;
  prompt: string | null;
  temperature: string | null;
  maxTokens: number | null;
  maxSteps: number;
  toolChoice: string;
  credentialId: string;
}

interface ToolRow {
  toolType: string;
  mcpServerId: string | null;
  mcpToolName: string | null;
  skillId: string | null;
  builtinTool: string | null;
  dataSourceId: string | null;
  sshServerId: string | null;
}

/** Production loader: DB row + decrypted credential. CONTRACT: returns
 *  null on missing / disabled agent or undecryptable credential —
 *  caller treats as 404 / 503. */
export const defaultLoadAgentSpec: AgentSpecLoader = async (agentId) => {
  const agentRows: AgentRow[] = await db
    .select({
      id: BuiltinAgentTable.id,
      name: BuiltinAgentTable.name,
      isSupervisor: BuiltinAgentTable.isSupervisor,
      role: BuiltinAgentTable.role,
      modelProvider: BuiltinAgentTable.modelProvider,
      model: BuiltinAgentTable.model,
      prompt: BuiltinAgentTable.prompt,
      temperature: BuiltinAgentTable.temperature,
      maxTokens: BuiltinAgentTable.maxTokens,
      maxSteps: BuiltinAgentTable.maxSteps,
      toolChoice: BuiltinAgentTable.toolChoice,
      credentialId: BuiltinAgentTable.credentialId,
    })
    .from(BuiltinAgentTable)
    .where(
      and(
        eq(BuiltinAgentTable.id, agentId),
        eq(BuiltinAgentTable.enabled, true),
      ),
    )
    .limit(1);

  const agent: AgentRow | undefined = agentRows[0];
  if (!agent) return null;

  // The credential lookup itself is already cached; agent pool memoizes the joined spec on top.
  const credential = await getCredentialConfigById(agent.credentialId);
  if (!credential || !credential.token) return null;

  const toolRows: ToolRow[] = await db
    .select({
      toolType: BuiltinAgentToolTable.toolType,
      mcpServerId: BuiltinAgentToolTable.mcpServerId,
      mcpToolName: BuiltinAgentToolTable.mcpToolName,
      skillId: BuiltinAgentToolTable.skillId,
      builtinTool: BuiltinAgentToolTable.builtinTool,
      dataSourceId: BuiltinAgentToolTable.dataSourceId,
      sshServerId: BuiltinAgentToolTable.sshServerId,
    })
    .from(BuiltinAgentToolTable)
    .where(eq(BuiltinAgentToolTable.agentId, agentId))
    .orderBy(asc(BuiltinAgentToolTable.order));

  const tools: AgentToolRef[] = toolRows.flatMap((row) => {
    const ref: AgentToolRef | null = mapToolRow(row);
    return ref ? [ref] : [];
  });

  return {
    agentId: agent.id,
    name: agent.name,
    isSupervisor: agent.isSupervisor,
    role: agent.role,
    modelProvider: agent.modelProvider,
    model: agent.model,
    prompt: agent.prompt,
    temperature: agent.temperature !== null ? parseFloat(agent.temperature) : null,
    maxTokens: agent.maxTokens,
    toolChoice: agent.toolChoice as AgentToolChoice,
    maxSteps: agent.maxSteps,
    apiKey: credential.token,
    restUrl: credential.restUrl,
    tools,
  };
};

/** 
 * Returns null for rows whose required FK is missing (dangling bindings from
 * `ON DELETE SET NULL`), so the runtime silently ignores non-existent tools. 
 */
function mapToolRow(row: ToolRow): AgentToolRef | null {
  const kind: AgentToolType = row.toolType as AgentToolType;
  switch (kind) {
    case "mcp_server":
      return row.mcpServerId
        ? { kind: "mcp_server", mcpServerId: row.mcpServerId }
        : null;
    case "mcp_tool":
      return row.mcpServerId && row.mcpToolName
        ? {
            kind: "mcp_tool",
            mcpServerId: row.mcpServerId,
            toolName: row.mcpToolName,
          }
        : null;
    case "skill":
      return row.skillId ? { kind: "skill", skillId: row.skillId } : null;
    case "builtin_tool":
      return row.builtinTool ? { kind: "builtin_tool", name: row.builtinTool } : null;
    case "datasource":
      return row.dataSourceId
        ? { kind: "datasource", dataSourceId: row.dataSourceId }
        : null;
    case "ssh_server":
      return row.sshServerId
        ? { kind: "ssh_server", sshServerId: row.sshServerId }
        : null;
    default: {
      // CONTRACT: extending `AgentToolType` without updating this
      // switch is a compile-time error.
      const _exhaustive: never = kind;
      void _exhaustive;
      return null;
    }
  }
}
