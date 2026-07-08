import "server-only";

import { and, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { BuiltinAgentTable, UserTable } from "@/lib/db/schema";

/**
 * Returns false (no throw) for non-existent / disabled / not-owned-
 * private agents.
 *
 * SECURITY: callers must respond with 404 in BOTH "not found" and
 * "forbidden" cases to avoid leaking the existence of other users'
 * private agents.
 */
export async function isAgentVisibleTo(
  agentId: string,
  userId: string,
): Promise<boolean> {
  const rows: Array<{ visibility: string; createdBy: string | null }> = await db
    .select({
      visibility: BuiltinAgentTable.visibility,
      createdBy: BuiltinAgentTable.createdBy,
    })
    .from(BuiltinAgentTable)
    .where(
      and(
        eq(BuiltinAgentTable.id, agentId),
        eq(BuiltinAgentTable.enabled, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return false;

  // Admin users bypass visibility rules and can view all enabled agents
  const userRows = await db
    .select({ role: UserTable.role })
    .from(UserTable)
    .where(eq(UserTable.id, userId))
    .limit(1);
  const isAdmin = userRows[0]?.role === "admin";

  return row.visibility === "public" || row.createdBy === userId || isAdmin;
}

/**
 * Enumerate every Built-in agent the user can invoke. Used when the
 * request URL doesn't name a specific agent (CopilotKit `/info`,
 * `/threads/*` bookkeeping).
 *
 * QUIRK: the single-agent path uses `isAgentVisibleTo` —
 * `listVisibleAgentIds().includes()` would round-trip for what the
 * indexed point lookup already knows.
 */
export async function listVisibleAgentIds(userId: string): Promise<string[]> {
  const userRows = await db
    .select({ role: UserTable.role })
    .from(UserTable)
    .where(eq(UserTable.id, userId))
    .limit(1);
  const isAdmin = userRows[0]?.role === "admin";

  const rows: Array<{ id: string }> = await db
    .select({ id: BuiltinAgentTable.id })
    .from(BuiltinAgentTable)
    .where(
      and(
        eq(BuiltinAgentTable.enabled, true),
        isAdmin
          ? undefined
          : or(
              eq(BuiltinAgentTable.visibility, "public"),
              eq(BuiltinAgentTable.createdBy, userId),
            ),
      ),
    );
  return rows.map((r) => r.id);
}
