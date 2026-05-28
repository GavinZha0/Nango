/**
 * Process-wide MCP provider pool singleton + DB-backed config loader.
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
 * AUTH: shares the same header-resolution function as the admin/test path
 * (`withMcpAdminClient`) — handles `Bearer` for `Authorization`, raw token
 * for custom header names, and the `oauth_client` credential type
 * (calls `getOAuthAccessToken` under the hood). Keeping both transports
 * on the same helper avoids drift where one path supports OAuth and the
 * other silently ships requests without auth.
 *
 * REFRESH NOTE: the headers materialized here are snapshotted into the
 * pool's transport at connect time. The pool's idle reaper closes
 * connections after `cache.mcp_pool.idle_timeout` (default 5 min), which
 * is well below typical OAuth token lifetimes (~1 h), so the next borrow
 * naturally re-runs `loadConfig` and picks up a fresh token. If you tune
 * `idleTimeoutMs` above the token lifetime you'll need to switch to a
 * per-request header builder.
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

// QUIRK: module-init side effects (reaper start) are intentional —
// this file is only ever imported from server-only paths and Next.js
// shares the module across requests inside the same Node process.
//
// HMR-survival via globalThis: a re-evaluation during `next dev` save
// would otherwise abandon every refcounted MCP connection AND leave
// the prior reaper timer alive. The guard ensures both the pool and
// its reaper start exactly once per Node process boot.
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
