import "server-only";

import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
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
  describeMissingDeclaredScripts,
  describeMissingSshScripts,
  findMissingDeclaredScripts,
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
// Full row including the SKILL.md text, the helper-file listing (path / size /
// contentType — no content) and the scripts-on-ssh diagnostic.

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const row = await loadVisibleSkill(params.id, session);

    // One listing feeds both the editor's file tree and the scripts-on-ssh
    // diagnostic. Sorted here so every consumer sees the same order instead
    // of re-sorting client-side.
    const stored = await getDbSkillStorage().listFiles(row.id);
    const files = [...stored].sort((a, b) =>
      a.path.localeCompare(b.path, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );

    // Diagnostic for rows that predate write-time validation: the editor can
    // show which declarations are unbacked instead of letting the agent
    // discover it mid-run.
    let missingSshScripts: string[] = [];
    let scriptsOnSsh: string[] = [];
    let missingDbScripts: string[] = [];
    let scriptsOnDb: string[] = [];
    try {
      const parsed = parseSkillMd(row.skillMd);
      const paths = files.map((f) => f.path);
      if (parsed.frontmatter.scriptsOnSsh?.length) {
        scriptsOnSsh = parsed.frontmatter.scriptsOnSsh;
        missingSshScripts = findMissingSshScripts(scriptsOnSsh, paths);
      }
      if (parsed.frontmatter.scriptsOnDb?.length) {
        scriptsOnDb = parsed.frontmatter.scriptsOnDb;
        missingDbScripts = findMissingDeclaredScripts(scriptsOnDb, paths);
      }
    } catch (err) {
      // A malformed stored body must not turn a read into a 500; the editor
      // surfaces it through the body itself.
      if (!(err instanceof SkillParseError)) throw err;
    }
    return NextResponse.json({
      ...row,
      files,
      scriptsOnSsh,
      missingSshScripts,
      scriptsOnDb,
      missingDbScripts,
    });
  },
);

// PATCH /api/skills/[id]
// Editors can rewrite SKILL.md (including its frontmatter `name`), update the
// free-form source label, or toggle enabled / visibility.

const updateSchema = z
  .object({
    skillMd: z.string().min(1).optional(),
    /** Free-form origin label (e.g. "anthropic", "skills.sh"); "" = unlabeled. */
    source: z.string().max(200).optional(),
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
      visibility: row.visibility as "private" | "public",
      createdBy: row.createdBy,
    };

    const editsContent = body.skillMd !== undefined || body.source !== undefined;
    if (editsContent && !canEditResource(rbac, session)) {
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

    if (editsContent) {
      const nextSkillMd = body.skillMd ?? row.skillMd;
      let parsed;
      try {
        parsed = parseSkillMd(nextSkillMd);
      } catch (err) {
        if (err instanceof SkillParseError) {
          throw new ApiError("VALIDATION_FAILED", 400, err.message);
        }
        throw err;
      }
      // Frontmatter owns the name. Renaming is allowed, but the new name must
      // be unique per creator so agent-binding lookups stay deterministic.
      // Frontmatter is the source of truth. Any content edit re-syncs `name`,
      // so a drifted row is checked as a rename too — a source-only update must
      // not slip a rename past the uniqueness gate.
      if (parsed.frontmatter.name !== row.name && row.createdBy) {
        const [duplicate] = await db
          .select({ id: SkillTable.id })
          .from(SkillTable)
          .where(
            and(
              eq(SkillTable.name, parsed.frontmatter.name),
              eq(SkillTable.createdBy, row.createdBy),
              ne(SkillTable.id, row.id),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw new ApiError(
            "CONFLICT",
            409,
            `A skill named "${parsed.frontmatter.name}" already exists for this creator.`,
          );
        }
      }
      // scripts-on-ssh and scripts-on-db are validated against the files that
      // already exist: an editor can freely rewrite frontmatter, but a
      // declaration with no backing skill_file can only fail later at runtime.
      const declaredSsh = parsed.frontmatter.scriptsOnSsh?.length ?? 0;
      const declaredDb = parsed.frontmatter.scriptsOnDb?.length ?? 0;
      if (body.skillMd !== undefined && (declaredSsh > 0 || declaredDb > 0)) {
        const available = (await storage.listFiles(row.id)).map((f) => f.path);
        if (declaredSsh > 0) {
          const missing = findMissingSshScripts(
            parsed.frontmatter.scriptsOnSsh ?? [],
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
        if (declaredDb > 0) {
          const missing = findMissingDeclaredScripts(
            parsed.frontmatter.scriptsOnDb ?? [],
            available,
          );
          if (missing.length > 0) {
            throw new ApiError(
              "VALIDATION_FAILED",
              400,
              describeMissingDeclaredScripts(
                missing,
                available,
                "scripts-on-db",
              ),
            );
          }
        }
      }

      await storage.updateContent({
        skillId: row.id,
        skillMd: nextSkillMd,
        source: body.source,
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

    if (editsContent || body.enabled !== undefined || body.visibility !== undefined) {
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
// Removes the row; skill_file rows cascade via the FK.

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const row = await loadVisibleSkill(params.id, session);
    const rbac = {
      visibility: row.visibility as "private" | "public",
      createdBy: row.createdBy,
    };

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
