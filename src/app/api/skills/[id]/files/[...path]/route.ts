/**
 * GET / PATCH / DELETE a single skill helper file or folder.
 *
 * Folders are implicit path prefixes; there is no folder table. PATCH renames
 * (and optionally rewrites text), DELETE removes a file or every descendant.
 * `scripts-on-ssh` declarations are synchronized in the same transaction.
 *
 * @see docs/skills.md
 */

import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { canViewResource } from "@/lib/auth/permissions";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { invalidateForSkillChange } from "@/lib/cache/invalidation";
import { loadEditableSkill } from "@/lib/skills/api-access";
import {
  syncDbDeclarationForRename,
  syncDbDeclarationsForDelete,
  syncDbDeclarationsForFolderRename,
  syncDeclarationForRename,
  syncDeclarationsForDelete,
  syncDeclarationsForFolderRename,
} from "@/lib/skills/declaration-sync";
import {
  assertEditorRenamePath,
  assertPathFree,
  assertSkillPath,
  assertUserName,
  isUniqueViolation,
} from "@/lib/skills/file-api";
import { validateImageBytes } from "@/lib/skills/import-policy";
import { getParentPath } from "@/lib/paths";
import {
  isScriptsFolder,
  joinSkillPath,
} from "@/lib/skills/file-rules";
import { guessContentType } from "@/lib/folder-import/mime";
import { SkillParseError } from "@/lib/skills/parser";
import {
  getDbSkillStorage,
  InvalidSkillPathError,
  type SkillFileRecord,
} from "@/lib/skills/storage";

const ROUTE = "/api/skills/[id]/files/[...path]";

function filenameFrom(params: { path?: string[] }): string {
  return (params.path ?? []).join("/");
}

function requestedKind(req: Request): "file" | "folder" {
  return new URL(req.url).searchParams.get("kind") === "folder" ? "folder" : "file";
}

/** Apply both scripts-on-ssh and scripts-on-db rewrites in order. */
function syncRenameDeclarations(
  skillMd: string,
  oldPath: string,
  newPath: string,
): { skillMd?: string; warning?: string } {
  let next = skillMd;
  let changed = false;
  let warning: string | undefined;

  const ssh = syncDeclarationForRename(next, oldPath, newPath);
  if (ssh.conflict) {
    throw new ApiError(
      "CONFLICT",
      409,
      `"${newPath}" is already declared in scripts-on-ssh.`,
    );
  }
  if (ssh.changed) {
    next = ssh.skillMd;
    changed = true;
  }
  if (ssh.warning) warning = ssh.warning;

  const db = syncDbDeclarationForRename(next, oldPath, newPath);
  if (db.conflict) {
    throw new ApiError(
      "CONFLICT",
      409,
      `"${newPath}" is already declared in scripts-on-db.`,
    );
  }
  if (db.changed) {
    next = db.skillMd;
    changed = true;
  }
  if (db.warning) {
    warning = warning ? `${warning} ${db.warning}` : db.warning;
  }

  return { skillMd: changed ? next : undefined, warning };
}

function syncFolderRenameDeclarations(
  skillMd: string,
  oldPath: string,
  newPath: string,
): string | undefined {
  let next = skillMd;
  let changed = false;

  const ssh = syncDeclarationsForFolderRename(next, oldPath, newPath);
  if (ssh.conflict) {
    throw new ApiError(
      "CONFLICT",
      409,
      "Renaming would duplicate an entry in scripts-on-ssh.",
    );
  }
  if (ssh.changed) {
    next = ssh.skillMd;
    changed = true;
  }

  const db = syncDbDeclarationsForFolderRename(next, oldPath, newPath);
  if (db.conflict) {
    throw new ApiError(
      "CONFLICT",
      409,
      "Renaming would duplicate an entry in scripts-on-db.",
    );
  }
  if (db.changed) {
    next = db.skillMd;
    changed = true;
  }

  return changed ? next : undefined;
}

function syncDeleteDeclarations(
  skillMd: string,
  paths: readonly string[],
): string | undefined {
  let next = skillMd;
  let changed = false;

  const ssh = syncDeclarationsForDelete(next, paths);
  if (ssh.changed) {
    next = ssh.skillMd;
    changed = true;
  }
  const db = syncDbDeclarationsForDelete(next, paths);
  if (db.changed) {
    next = db.skillMd;
    changed = true;
  }

  return changed ? next : undefined;
}

// GET /api/skills/[id]/files/[...path]
export const GET = withSession<{ id: string; path: string[] }>(
  ROUTE,
  async ({ params, session }) => {
    const [row] = await db
      .select({
        id: SkillTable.id,
        visibility: SkillTable.visibility,
        createdBy: SkillTable.createdBy,
      })
      .from(SkillTable)
      .where(eq(SkillTable.id, params.id))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", 404, "Skill not found.");
    // SECURITY: same predicate the skill-detail route uses. A hand-rolled
    // `visibility === 'public' || createdBy === me` check omits the admin
    // exception, which would let an admin list a private skill's files and
    // then 404 on every one of them.
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

    const filename: string = filenameFrom(params);
    if (filename.length === 0) {
      throw new ApiError("BAD_REQUEST", 400, "Missing filename.");
    }

    const storage = getDbSkillStorage();
    // A bare filename is resolved against the skill's actual listing rather
    // than a fixed prefix list: authors name their folders freely, so the
    // archive layout is the only source of truth. Sorted so a duplicate
    // basename resolves deterministically instead of by DB row order.
    const candidates: string[] = filename.includes("/")
      ? [filename]
      : (await storage.listFiles(row.id))
          .map((f) => f.path)
          .filter((p) => p.slice(p.lastIndexOf("/") + 1) === filename)
          .sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
          );

    let found: SkillFileRecord | null = null;
    for (const candidate of candidates) {
      try {
        const rec = await storage.readFile(row.id, candidate);
        if (rec) {
          found = rec;
          break;
        }
      } catch (err) {
        if (err instanceof InvalidSkillPathError) {
          throw new ApiError("BAD_REQUEST", 400, err.message);
        }
        throw err;
      }
    }
    if (!found) {
      throw new ApiError("NOT_FOUND", 404, `File not found: ${filename}`);
    }

    const isText: boolean = isLikelyText(found.content);
    return NextResponse.json({
      path: found.path,
      encoding: isText ? "utf8" : "base64",
      content: isText
        ? found.content.toString("utf8")
        : found.content.toString("base64"),
      size: found.size,
    });
  },
);

// PATCH /api/skills/[id]/files/[...path]?kind=file|folder
const updateSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    content: z.string().optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string; path: string[] }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const skill = await loadEditableSkill(params.id, session);
    const kind = requestedKind(req);
    const oldPath = filenameFrom(params);
    const updatedBy = session.user.id;

    if (!oldPath) throw new ApiError("BAD_REQUEST", 400, "Missing file path.");
    if (body.name === undefined && body.content === undefined) {
      throw new ApiError("BAD_REQUEST", 400, "Nothing to update.");
    }

    const storage = getDbSkillStorage();

    if (kind === "folder") {
      if (body.content !== undefined) {
        throw new ApiError("BAD_REQUEST", 400, "Folders have no content.");
      }
      if (body.name === undefined) {
        throw new ApiError("BAD_REQUEST", 400, "Folder rename requires a name.");
      }
      const name = body.name.trim();
      assertUserName(name);
      if (isScriptsFolder(oldPath)) {
        throw new ApiError(
          "BAD_REQUEST",
          400,
          "The top-level scripts/ folder is reserved and cannot be renamed.",
        );
      }

      const files = await storage.listFiles(skill.id);
      const prefix = `${oldPath}/`;
      const affected = files
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => f.path);
      if (affected.length === 0) {
        throw new ApiError("NOT_FOUND", 404, `Folder not found: ${oldPath}`);
      }

      const newPath = joinSkillPath(getParentPath(oldPath), name);
      assertSkillPath(newPath);
      if (newPath !== oldPath) {
        const outside = files.filter((f) => !f.path.startsWith(prefix));
        if (
          outside.some(
            (f) => f.path === newPath || f.path.startsWith(`${newPath}/`),
          )
        ) {
          throw new ApiError(
            "CONFLICT",
            409,
            `A file or folder already exists at "${newPath}".`,
          );
        }
      }

      let skillMd: string | undefined;
      if (
        oldPath.startsWith("scripts/") ||
        newPath.startsWith("scripts/")
      ) {
        try {
          skillMd = syncFolderRenameDeclarations(
            skill.skillMd,
            oldPath,
            newPath,
          );
        } catch (err) {
          if (err instanceof SkillParseError) {
            throw new ApiError(
              "VALIDATION_FAILED",
              400,
              `Cannot sync script declarations: ${err.message}`,
            );
          }
          throw err;
        }
      }

      try {
        await storage.renameFolder({
          skillId: skill.id,
          oldPath,
          newPath,
          skillMd,
          updatedBy,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError(
            "CONFLICT",
            409,
            `A file or folder already exists at "${newPath}".`,
          );
        }
        if (err instanceof InvalidSkillPathError) {
          throw new ApiError("VALIDATION_FAILED", 400, err.message);
        }
        throw err;
      }
      if (skillMd !== undefined) await invalidateForSkillChange(skill.id);
      return NextResponse.json({
        ok: true,
        path: newPath,
        files: affected.length,
      });
    }

    const current = await storage.readFile(skill.id, oldPath);
    if (!current) {
      throw new ApiError("NOT_FOUND", 404, `File not found: ${oldPath}`);
    }

    const name = body.name?.trim();
    if (name !== undefined) assertUserName(name);

    const newPath =
      name !== undefined ? joinSkillPath(getParentPath(oldPath), name) : oldPath;
    assertSkillPath(newPath);
    if (newPath !== oldPath) {
      const policy = assertEditorRenamePath(newPath);
      await assertPathFree(skill.id, newPath);
      if (policy.action === "allow-text" && !isLikelyText(current.content)) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          "Cannot rename binary content to a text file type.",
        );
      }
      if (policy.action === "allow-image") {
        if (isLikelyText(current.content)) {
          throw new ApiError(
            "VALIDATION_FAILED",
            400,
            "Cannot rename text content to an image file type.",
          );
        }
        const imageError = validateImageBytes(newPath, current.content);
        if (imageError) {
          throw new ApiError("VALIDATION_FAILED", 400, imageError);
        }
      }
    }

    let content: Buffer | undefined;
    let contentType: string | null | undefined;
    if (body.content !== undefined) {
      if (!isLikelyText(current.content)) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          "Binary files cannot be edited as text.",
        );
      }
      if (body.content.includes("\0")) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          "Text files cannot contain NUL bytes.",
        );
      }
      content = Buffer.from(body.content, "utf8");
      contentType = guessContentType(newPath) ?? "text/plain";
    }

    let skillMd: string | undefined;
    let warning: string | undefined;
    if (oldPath.startsWith("scripts/") || newPath.startsWith("scripts/")) {
      try {
        const sync = syncRenameDeclarations(skill.skillMd, oldPath, newPath);
        skillMd = sync.skillMd;
        warning = sync.warning;
      } catch (err) {
        if (err instanceof SkillParseError) {
          throw new ApiError(
            "VALIDATION_FAILED",
            400,
            `Cannot sync script declarations: ${err.message}`,
          );
        }
        throw err;
      }
    }

    try {
      await storage.updateFile({
        skillId: skill.id,
        oldPath,
        newPath,
        content,
        contentType,
        skillMd,
        updatedBy,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(
          "CONFLICT",
          409,
          `A file already exists at "${newPath}".`,
        );
      }
      if (err instanceof InvalidSkillPathError) {
        throw new ApiError("VALIDATION_FAILED", 400, err.message);
      }
      throw err;
    }

    if (skillMd !== undefined) await invalidateForSkillChange(skill.id);

    return NextResponse.json({
      ok: true,
      path: newPath,
      size: content?.length ?? current.size,
      contentType: contentType ?? current.contentType,
      warning,
    });
  },
);

// DELETE /api/skills/[id]/files/[...path]?kind=file|folder
export const DELETE = withEditor<{ id: string; path: string[] }>(
  ROUTE,
  async ({ req, params, session }) => {
    const skill = await loadEditableSkill(params.id, session);
    const kind = requestedKind(req);
    const path = filenameFrom(params);
    const updatedBy = session.user.id;

    if (!path) throw new ApiError("BAD_REQUEST", 400, "Missing file path.");
    const storage = getDbSkillStorage();

    if (kind === "file") {
      const existing = await storage.readFile(skill.id, path);
      if (!existing) {
        throw new ApiError("NOT_FOUND", 404, `File not found: ${path}`);
      }

      let skillMd: string | undefined;
      if (path.startsWith("scripts/")) {
        try {
          skillMd = syncDeleteDeclarations(skill.skillMd, [path]);
        } catch (err) {
          if (err instanceof SkillParseError) {
            throw new ApiError(
              "VALIDATION_FAILED",
              400,
              `Cannot sync script declarations: ${err.message}`,
            );
          }
          throw err;
        }
      }

      await storage.deleteFile(
        skill.id,
        path,
        skillMd !== undefined ? { skillMd, updatedBy } : undefined,
      );
      if (skillMd !== undefined) await invalidateForSkillChange(skill.id);
      return new NextResponse(null, { status: 204 });
    }

    const files = await storage.listFiles(skill.id);
    const prefix = `${path}/`;
    const affected = files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => f.path);
    if (affected.length === 0) {
      throw new ApiError("NOT_FOUND", 404, `Folder not found: ${path}`);
    }

    let skillMd: string | undefined;
    // Declarations may live in any sub-directory under scripts/.
    if (path === "scripts" || path.startsWith("scripts/")) {
      try {
        skillMd = syncDeleteDeclarations(skill.skillMd, affected);
      } catch (err) {
        if (err instanceof SkillParseError) {
          throw new ApiError(
            "VALIDATION_FAILED",
            400,
            `Cannot sync script declarations: ${err.message}`,
          );
        }
        throw err;
      }
    }

    await storage.deleteFolder({
      skillId: skill.id,
      path,
      skillMd,
      updatedBy,
    });
    if (skillMd !== undefined) await invalidateForSkillChange(skill.id);
    return new NextResponse(null, { status: 204 });
  },
);

function isLikelyText(buf: Buffer): boolean {
  const slice: Buffer = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  return !slice.includes(0);
}
