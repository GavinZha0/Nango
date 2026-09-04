import "server-only";

import { and, asc, eq, ilike, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { McpServerTable } from "@/lib/db/schema";

/**
 * Auto-discovery for the shared Playwright execution environment.
 *
 * Mirrors the UI's two-pass matching (WebAutoSuiteDialog): an exact name of
 * "playwright"/"playwright-mcp" wins, then any name containing "playwright".
 * Only enabled PUBLIC servers are considered — a user's private server must be
 * selected explicitly and is never auto-bound.
 */
export async function discoverPublicPlaywrightMcpServer(): Promise<string | null> {
  const exact = await db
    .select({ id: McpServerTable.id })
    .from(McpServerTable)
    .where(
      and(
        eq(McpServerTable.enabled, true),
        eq(McpServerTable.visibility, "public"),
        sql`lower(${McpServerTable.name}) IN ('playwright', 'playwright-mcp')`,
      ),
    )
    .orderBy(asc(McpServerTable.createdAt))
    .limit(1);

  if (exact[0]) return exact[0].id;

  const partial = await db
    .select({ id: McpServerTable.id })
    .from(McpServerTable)
    .where(
      and(
        eq(McpServerTable.enabled, true),
        eq(McpServerTable.visibility, "public"),
        ilike(McpServerTable.name, "%playwright%"),
      ),
    )
    .orderBy(asc(McpServerTable.createdAt))
    .limit(1);

  return partial[0]?.id ?? null;
}
