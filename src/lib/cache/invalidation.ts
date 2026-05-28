/**
 * Unified cascade invalidation — single definition site for all
 * `invalidateFor*` functions. API write routes call exactly ONE
 * function per write; no separate `invalidateCredentialCache()` needed.
 *
 * @see docs/cache.md §3
 * @see docs/builtin-runtime.md §4
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { BuiltinAgentToolTable, McpServerTable } from "@/lib/db/schema";

import { agentPool } from "@/lib/builtin-agents";
import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { mcpProviderPool } from "@/lib/mcp";
import { skillPool } from "@/lib/skills";
import { invalidateCredentialCache } from "@/lib/credentials/lookup";

/**
 * Call after any credential write. Clears the credential lookup cache
 * (triggers `onCredentialCacheInvalidated` subscribers, e.g. Langfuse),
 * then cascades to agent pool, MCP pool, and entity catalog.
 */
export async function invalidateForCredentialChange(
  credentialId: string,
): Promise<void> {
  invalidateCredentialCache();
  EntityCatalog.invalidate(credentialId);

  const evictMcp = (async (): Promise<void> => {
    const rows: Array<{ id: string }> = await db
      .select({ id: McpServerTable.id })
      .from(McpServerTable)
      .where(eq(McpServerTable.credentialId, credentialId));
    await Promise.all(rows.map((r) => mcpProviderPool.evict(r.id)));
  })();

  await Promise.all([
    agentPool.invalidateByCredential(credentialId),
    evictMcp,
  ]);
}

/** Invalidate MCP provider pool + every AgentSpec that binds the server. */
export async function invalidateForMcpServerChange(
  mcpServerId: string,
): Promise<void> {
  const invalidateAgents = (async (): Promise<void> => {
    const rows: Array<{ agentId: string }> = await db
      .select({ agentId: BuiltinAgentToolTable.agentId })
      .from(BuiltinAgentToolTable)
      .where(
        and(
          eq(BuiltinAgentToolTable.toolType, "mcp_server"),
          eq(BuiltinAgentToolTable.mcpServerId, mcpServerId),
        ),
      );
    // Dedupe: an agent can bind the same server through multiple junction rows.
    const uniqueAgentIds: Set<string> = new Set(rows.map((r) => r.agentId));
    for (const id of uniqueAgentIds) agentPool.invalidate(id);
  })();

  await Promise.all([mcpProviderPool.evict(mcpServerId), invalidateAgents]);
}

/**
 * Invalidate skill pool + every AgentSpec that binds the skill.
 * @see docs/skills.md
 */
export async function invalidateForSkillChange(
  skillId: string,
): Promise<void> {
  skillPool.invalidate(skillId);

  const rows: Array<{ agentId: string }> = await db
    .select({ agentId: BuiltinAgentToolTable.agentId })
    .from(BuiltinAgentToolTable)
    .where(
      and(
        eq(BuiltinAgentToolTable.toolType, "skill"),
        eq(BuiltinAgentToolTable.skillId, skillId),
      ),
    );

  const uniqueAgentIds: Set<string> = new Set(rows.map((r) => r.agentId));
  for (const id of uniqueAgentIds) agentPool.invalidate(id);
}

/**
 * Invalidate every AgentSpec that binds the data source so the
 * "Available data sources" prompt block refreshes.
 */
export async function invalidateForDataSourceChange(
  dataSourceId: string,
): Promise<void> {
  const rows: Array<{ agentId: string }> = await db
    .select({ agentId: BuiltinAgentToolTable.agentId })
    .from(BuiltinAgentToolTable)
    .where(
      and(
        eq(BuiltinAgentToolTable.toolType, "datasource"),
        eq(BuiltinAgentToolTable.dataSourceId, dataSourceId),
      ),
    );
  const uniqueAgentIds: Set<string> = new Set(rows.map((r) => r.agentId));
  for (const id of uniqueAgentIds) agentPool.invalidate(id);
}

/**
 * Invalidate every AgentSpec that binds the SSH server so the
 * "Available SSH hosts" prompt block refreshes.
 */
export async function invalidateForSshServerChange(
  sshServerId: string,
): Promise<void> {
  const rows: Array<{ agentId: string }> = await db
    .select({ agentId: BuiltinAgentToolTable.agentId })
    .from(BuiltinAgentToolTable)
    .where(
      and(
        eq(BuiltinAgentToolTable.toolType, "ssh_server"),
        eq(BuiltinAgentToolTable.sshServerId, sshServerId),
      ),
    );
  const uniqueAgentIds: Set<string> = new Set(rows.map((r) => r.agentId));
  for (const id of uniqueAgentIds) agentPool.invalidate(id);
}

/**
 * Call after any builtin agent write. Currently only clears the agent
 * pool; centralized here so future downstream caches can be added
 * without touching route handlers.
 */
export function invalidateForAgentChange(agentId: string): void {
  agentPool.invalidate(agentId);
}
