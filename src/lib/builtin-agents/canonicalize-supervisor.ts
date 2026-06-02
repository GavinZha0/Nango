import "server-only";

// Boot-time canonicalisation for supervisor agents — see docs/prompts.md.

import { and, eq, or, ne } from "drizzle-orm";

import { db } from "@/lib/db";
import { BuiltinAgentTable } from "@/lib/db/schema";
import {
  SUPERVISOR_DESCRIPTION,
  SUPERVISOR_NAME,
  SUPERVISOR_PROMPT,
} from "@/lib/constants/supervisor";
import { agentPool } from "@/lib/builtin-agents";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "supervisor-canonicalize" });

/** Sync every supervisor row to the canonical constants. Returns the
 *  ids that were actually changed. */
export async function canonicalizeSupervisorAgents(): Promise<string[]> {
  const updated = await db
    .update(BuiltinAgentTable)
    .set({
      name: SUPERVISOR_NAME,
      description: SUPERVISOR_DESCRIPTION,
      prompt: SUPERVISOR_PROMPT,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(BuiltinAgentTable.role, "supervisor"),
        or(
          ne(BuiltinAgentTable.name, SUPERVISOR_NAME),
          ne(BuiltinAgentTable.description, SUPERVISOR_DESCRIPTION),
          ne(BuiltinAgentTable.prompt, SUPERVISOR_PROMPT),
        ),
      ),
    )
    .returning({ id: BuiltinAgentTable.id });

  const ids = updated.map((r) => r.id);
  if (ids.length > 0) {
    // Defensive against HMR / instrumentation re-evaluation populating
    // the pool before this sweep runs.
    for (const id of ids) agentPool.invalidate(id);
    log.info(
      { event: "supervisor_canonicalized", count: ids.length, ids },
      "synced supervisor rows to canonical constants",
    );
  }
  return ids;
}
