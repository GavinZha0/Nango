import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession, type Session } from "@/lib/http/route-handlers";
import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
  canViewResource,
} from "@/lib/auth/permissions";
import { parseBody } from "@/lib/http/validation";
import { invalidateForSkillChange } from "@/lib/cache/invalidation";
import {
  describeMissingSshScripts,
  findMissingSshScripts,
  parseSkillMd,
  SkillParseError,
} from "@/lib/skills/parser";
import { getDbSkillStorage } from "@/lib/skills/storage";

const ROUTE = "/api/skills/[id]";

/**
 * Load skill row and assert read permission. Returns 404 on missing or hidden
 * (no differentiation to keep private ids opaque).
 */
async function loadVisibleSkill(skillId: string, session: Session) {
  const [row] = await db
    .select()
    .from(SkillTable)
    .where(eq(SkillTable.id, skillId))
    .limit(1);
  if (!row) throw new ApiError("NOT_FOUND", 404, "Skill not found.");
  if (
    !canViewResource(
      {
        source: row.source as "builtin" | "local",
        visibility: row.visibility as "private" | "public",
        createdBy: row.createdBy,
      },
      session,
    )
  ) {
    throw new ApiError("NOT_FOUND", 404, "Skill not found.");
  }
  return row;
}

// GET /api/skills/[id]
// Full row including the SKILL.md text, used by the editor / preview UI.

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const row = await loadVisibleSkill(params.id, session);
    // Diagnostic for rows that predate write-time validation: the editor can
    // show which declarations are unbacked instead of letting the agent
    // discover it mid-run.
    let missingSshScripts: string[] = [];
    try {
      const parsed = parseSkillMd(row.skillMd);
      if (parsed.frontmatter.scriptsOnSsh?.length) {
        const available = (await getDbSkillStorage().listFiles(row.id)).map(
          (f) => f.path,
        );
        missingSshScripts = findMissingSshScripts(
          parsed.frontmatter.scriptsOnSsh,
          available,
        );
      }
    } catch (err) {
      // A malformed stored body must not turn a read into a 500; the editor
      // surfaces it through the body itself.
      if (!(err instanceof SkillParseError)) throw err;
    }
    return NextResponse.json({ ...row, missingSshScripts });
  },
);

// PATCH /api/skills/[id]
// Editors can rewrite SKILL.md or toggle enabled / visibility on local
// skills. Builtin skills are read-only via the API; their content
// changes only via redeploy.

const updateSchema = z
  .object({
    skillMd: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const row = await loadVisibleSkill(params.id, session);

    const rbac = {
      source: row.source as "builtin" | "local",
      visibility: row.visibility as "private" | "public",
      createdBy: row.createdBy,
    };

    // Builtin is an absolute write barrier (see docs/rbac.md).
    if (rbac.source === "builtin") {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Builtin skills are read-only; edit the source in the codebase and redeploy.",
      );
    }

    if (body.skillMd !== undefined && !canEditResource(rbac, session)) {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this skill.");
    }
    if (
      (body.visibility !== undefined || body.enabled !== undefined)
      && !canChangeVisibility(rbac, session)
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled.",
      );
    }

    const storage = getDbSkillStorage();

    if (body.skillMd !== undefined) {
      let parsed;
      try {
        parsed = parseSkillMd(body.skillMd);
      } catch (err) {
        if (err instanceof SkillParseError) {
          throw new ApiError("VALIDATION_FAILED", 400, err.message);
        }
        throw err;
      }
      // Renaming via PATCH would orphan agent_tool references; require
      // delete + recreate instead.
      if (parsed.frontmatter.name !== row.name) {
        throw new ApiError(
          "BAD_REQUEST",
          400,
          `Renaming a skill via PATCH is not supported.  Skill is named "${row.name}".`,
        );
      }
      // scripts-on-ssh is validated against the files that already exist: an
      // editor can freely rewrite frontmatter, but a declaration with no
      // backing skill_file can only fail later as SCRIPT_NOT_FOUND on a
      // remote host.
      if (parsed.frontmatter.scriptsOnSsh?.length) {
        const available = (await storage.listFiles(row.id)).map((f) => f.path);
        const missing = findMissingSshScripts(
          parsed.frontmatter.scriptsOnSsh,
          available,
        );
        if (missing.length > 0) {
          throw new ApiError(
            "VALIDATION_FAILED",
            400,
            describeMissingSshScripts(missing, available),
          );
        }
      }

      await storage.updateContent({
        skillId: row.id,
        skillMd: body.skillMd,
        updatedBy: session.user.id,
      });
    }

    if (body.enabled !== undefined || body.visibility !== undefined) {
      await storage.updateFlags({
        skillId: row.id,
        enabled: body.enabled,
        visibility: body.visibility,
        updatedBy: session.user.id,
      });
    }

    if (body.skillMd !== undefined || body.enabled !== undefined || body.visibility !== undefined) {
      await invalidateForSkillChange(row.id);
    }

    const [updated] = await db
      .select()
      .from(SkillTable)
      .where(eq(SkillTable.id, row.id))
      .limit(1);
    return NextResponse.json(updated);
  },
);

// DELETE /api/skills/[id]
// Local: removes the row (skill_file rows cascade). Builtin: never
// deleted — the next boot reconcile would re-seed it from the bundle.

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const row = await loadVisibleSkill(params.id, session);
    const rbac = {
      source: row.source as "builtin" | "local",
      visibility: row.visibility as "private" | "public",
      createdBy: row.createdBy,
    };

    if (rbac.source === "builtin") {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Builtin skills cannot be deleted; toggle `enabled=false` instead.",
      );
    }
    if (!canDeleteResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this skill.",
      );
    }

    // Invalidate before deletion so the agent reverse-index still sees
    // the bindings; pool entries are keyed by id and survive the row.
    await invalidateForSkillChange(row.id);
    await getDbSkillStorage().delete(row.id);
    return new NextResponse(null, { status: 204 });
  },
);
