/**
 * POST /api/skills/[id]/files — create a text helper file.
 *
 * Folders are implicit: a parent path only exists while it contains files.
 * Binary assets are imported via `POST /api/skills/import`.
 *
 * @see docs/skills.md
 */

import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadEditableSkill } from "@/lib/skills/api-access";
import {
  assertParentFolder,
  assertParentIsNotFile,
  assertPathFree,
  assertSkillPath,
  assertTextFileRules,
  assertUserName,
  isUniqueViolation,
} from "@/lib/skills/file-api";
import { joinSkillPath } from "@/lib/skills/file-rules";
import {
  getDbSkillStorage,
  guessContentType,
  InvalidSkillPathError,
} from "@/lib/skills/storage";

const ROUTE = "/api/skills/[id]/files";

const createSchema = z
  .object({
    /** "" / omitted = skill root; otherwise an existing or new folder path. */
    parentFolder: z.string().max(256).optional(),
    name: z.string().min(1).max(256),
    /** UTF-8 text; omitted = empty file. */
    content: z.string().optional(),
  })
  .strict();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, createSchema);
    const skill = await loadEditableSkill(params.id, session);

    const name = body.name.trim();
    assertUserName(name);
    const parent = (body.parentFolder ?? "").trim();
    assertParentFolder(parent);

    const path = joinSkillPath(parent, name);
    assertSkillPath(path);
    assertTextFileRules(path);

    const text = body.content ?? "";
    if (text.includes("\0")) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        "Text files cannot contain NUL bytes.",
      );
    }

    await assertParentIsNotFile(skill.id, parent);
    await assertPathFree(skill.id, path);

    const content = Buffer.from(text, "utf8");
    const contentType = guessContentType(path) ?? "text/plain";
    const storage = getDbSkillStorage();

    try {
      await storage.putFile({
        skillId: skill.id,
        path,
        content,
        contentType,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError("CONFLICT", 409, `A file already exists at "${path}".`);
      }
      if (err instanceof InvalidSkillPathError) {
        throw new ApiError("VALIDATION_FAILED", 400, err.message);
      }
      throw err;
    }

    return NextResponse.json(
      { id: skill.id, path, size: content.length, contentType },
      { status: 201 },
    );
  },
);
