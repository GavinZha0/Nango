/**
 * Process-wide MCP provider pool singleton + DB-backed config loader.
 *
 * See docs/builtin-runtime.md.
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";

import { buildMcpHeaders } from "./admin-client.server";
import { McpProviderPool, type McpServerConfig } from "./provider-pool";

/**
 * Resolve an MCP server's config from DB, materializing auth headers.
 *
 * CONTRACT: returns null when the row is missing, disabled, or uses
 * an unsupported transport — caller treats as "no provider".
 *
 * SECURITY: credential decryption happens here (via {@link buildMcpHeaders}),
 * not in the pool, so the pool never sees plaintext tokens.
 *
 * REFRESH: headers are snapshotted into the pool's transport at
 * connect time. The pool's idle reaper closes connections after
 * `cache.mcp_pool.idle_timeout` (default 5 min) — well below typical
 * OAuth token lifetimes (~1 h) — so the next borrow re-runs
 * `loadConfig` and picks up a fresh token. Tuning `idleTimeoutMs`
 * above the token lifetime would require switching to a per-request
 * header builder.
 */
async function loadMcpServerConfig(
  serverId: string,
): Promise<McpServerConfig | null> {
  const rows = await db
    .select({
      id: McpServerTable.id,
      name: McpServerTable.name,
      type: McpServerTable.type,
      url: McpServerTable.url,
      headers: McpServerTable.headers,
      credentialId: McpServerTable.credentialId,
      credentialHeader: McpServerTable.credentialHeader,
    })
    .from(McpServerTable)
    .where(
      and(eq(McpServerTable.id, serverId), eq(McpServerTable.enabled, true)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.type !== "sse" && row.type !== "http") {
    return null;
  }

  const headers: Record<string, string> = await buildMcpHeaders({
    headers: row.headers,
    credentialId: row.credentialId,
    credentialHeader: row.credentialHeader,
  });

  return {
    serverId: row.id,
    label: row.name ?? row.id,
    type: row.type,
    url: row.url,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

// HMR-survival via globalThis — without this, `next dev` saves would
// abandon refcounted MCP connections AND leave the prior reaper timer
// alive. The guard ensures both the pool and its reaper start exactly
// once per Node process boot. Module-init side effects (reaper start)
// are intentional — this file is only imported from server-only paths.
declare global {
  var __nangoMcpProviderPool: McpProviderPool | undefined;
}

export const mcpProviderPool: McpProviderPool =
  (globalThis.__nangoMcpProviderPool ??= (() => {
    const pool = new McpProviderPool({ loadConfig: loadMcpServerConfig });
    pool.startReaper();
    return pool;
  })());

export { McpProviderPool } from "./provider-pool";
export type { McpServerConfig } from "./provider-pool";
