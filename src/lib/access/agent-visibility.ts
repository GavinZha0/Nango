import "server-only";

import { and, eq, isNull, ne, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { BuiltinAgentTable } from "@/lib/db/schema";
import { resolveAuthContext } from "@/lib/auth/permissions";

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
  const rows = await db
    .select({
      visibility: BuiltinAgentTable.visibility,
      createdBy: BuiltinAgentTable.createdBy,
      role: BuiltinAgentTable.role,
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
  const { isAdmin, isEditor } = await resolveAuthContext(userId);

  // Tester agents are restricted to editors and admins
  if (row.role === "tester" && !isEditor) {
    return false;
  }

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
  const { isAdmin, isEditor } = await resolveAuthContext(userId);

  const rows: Array<{ id: string }> = await db
    .select({ id: BuiltinAgentTable.id })
    .from(BuiltinAgentTable)
    .where(
      and(
        eq(BuiltinAgentTable.enabled, true),
        !isEditor
          ? or(
              isNull(BuiltinAgentTable.role),
              ne(BuiltinAgentTable.role, "tester"),
            )
          : undefined,
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
