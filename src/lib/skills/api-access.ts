/**
 * Shared RBAC load for skill-file write routes.
 *
 * @see docs/skills.md
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, type Session } from "@/lib/http/route-handlers";

/** Load a skill and assert the session may edit it. 404 hides private rows. */
export async function loadEditableSkill(
  skillId: string,
  session: Session,
): Promise<typeof SkillTable.$inferSelect> {
  const [row] = await db
    .select()
    .from(SkillTable)
    .where(eq(SkillTable.id, skillId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", 404, "Skill not found.");
  if (
    !canEditResource(
      {
        visibility: row.visibility as "private" | "public",
        createdBy: row.createdBy,
      },
      session,
    )
  ) {
    throw new ApiError("FORBIDDEN", 403, "You cannot edit this skill.");
  }
  return row;
}
