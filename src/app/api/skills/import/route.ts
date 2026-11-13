/**
 * POST /api/skills/import — import a folder of files as a custom skill.
 *
 * Transport, path legality, noise handling and byte budgets come from
 * `@/lib/folder-import`; the skills-specific part is the content allowlist
 * (`classifyImportPath`) and the `SKILL.md` → skill-row split.
 *
 * See docs/skills.md.
 */

import "server-only";

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { BuiltinAgentToolTable, SkillTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { invalidateForSkillChange } from "@/lib/cache/invalidation";
import {
  folderManifestSchema,
  type FolderEntry,
} from "@/lib/folder-import/manifest";
import {
  assertBodyWithinCap,
  assertNoBlocked,
  assertNoPathKindClash,
  walkEntries,
} from "@/lib/folder-import/preflight";
import { guessContentType } from "@/lib/folder-import/mime";
import {
  parseSkillMd,
  SkillParseError,
  buildSuffixedSkillName,
  isValidSkillName,
  rewriteSkillNameInSkillMd,
  findMissingSshScripts,
  describeMissingSshScripts,
  findMissingDeclaredScripts,
  describeMissingDeclaredScripts,
} from "@/lib/skills/parser";
import { getDbSkillStorage } from "@/lib/skills/storage";
import {
  describeUnusableSshScript,
  readSshScriptSource,
} from "@/lib/skills/ssh-script-source";
import {
  validateSkillFilePath,
  InvalidSkillPathError,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SKILL,
  MAX_TOTAL_BYTES_PER_SKILL,
} from "@/lib/skills/storage/skill-storage";
import { classifyImportPath, validateImageBytes } from "@/lib/skills/import-policy";

const ROUTE = "/api/skills/import";

// Request-body ceiling. base64 is a fixed 4/3 factor over the 10 MB decoded
// cap, plus JSON path overhead — 16 MB leaves comfortable headroom while
// still rejecting a hostile multi-hundred-MB body before `req.json()` reads it.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const skillImportSchema = folderManifestSchema.extend({
  conflictStrategy: z.enum(["fail", "overwrite", "rename"]).optional().default("fail"),
  customName: z.string().trim().min(1).optional(),
});

function randomDigits(len: number): string {
  const min = 10 ** (len - 1);
  const span = 9 * min;
  return String(min + Math.floor(Math.random() * span));
}

async function findOwnedSkillByName(userId: string, name: string): Promise<string | null> {
  const rows = await db
    .select({ id: SkillTable.id })
    .from(SkillTable)
    .where(and(eq(SkillTable.name, name), eq(SkillTable.createdBy, userId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  // 1. Reject an oversized body before buffering it.
  assertBodyWithinCap(req, MAX_REQUEST_BYTES);

  const body = await parseBody(req, skillImportSchema);

  // 2. SKILL.md is the skill's main document, stored on the row rather than as a
  //    helper file, so it leaves the manifest before the walker — which applies
  //    the helper-file path rules that reserve this name. A lowercase `skill.md`
  //    is not the main document and is refused as an invalid helper path.
  let skillMdText: string | null = null;
  const helperEntries: FolderEntry[] = [];
  for (const entry of body.entries) {
    if (entry.path === "SKILL.md") {
      skillMdText = Buffer.from(entry.contentBase64, "base64").toString("utf-8");
      continue;
    }
    helperEntries.push(entry);
  }

  const { files, skipped, blocked } = walkEntries(helperEntries, {
    caps: {
      maxFiles: MAX_FILES_PER_SKILL(),
      maxFileBytes: MAX_FILE_BYTES(),
      maxTotalBytes: MAX_TOTAL_BYTES_PER_SKILL(),
    },
    admit: classifyImportPath,
    validatePath: (path) => {
      try {
        validateSkillFilePath(path);
      } catch (err) {
        if (err instanceof InvalidSkillPathError) return "invalid path";
        throw err;
      }
      return null;
    },
    // The walker already scanned text for NUL bytes; images need magic-byte proof.
    validateContent: (path, content, action) =>
      action === "allow-image" ? validateImageBytes(path, content) : null,
  });

  // 3. A refused entry fails the whole import; a path cannot be both a file
  //    and a folder.
  assertNoBlocked(blocked);
  assertNoPathKindClash(files);

  // 4. Parse and validate SKILL.md.
  if (!skillMdText) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "The folder must contain a SKILL.md at its root.",
    );
  }
  let parsed;
  try {
    parsed = parseSkillMd(skillMdText);
  } catch (err) {
    if (err instanceof SkillParseError) {
      throw new ApiError("VALIDATION_FAILED", 400, err.message);
    }
    throw err;
  }

  // 5. scripts-on-ssh / scripts-on-db entries must be backed by a file in
  //    this same upload.
  if (parsed.frontmatter.scriptsOnSsh?.length) {
    const available = files.map((f) => f.path);
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
  if (parsed.frontmatter.scriptsOnDb?.length) {
    const available = files.map((f) => f.path);
    const missing = findMissingDeclaredScripts(
      parsed.frontmatter.scriptsOnDb,
      available,
    );
    if (missing.length > 0) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        describeMissingDeclaredScripts(missing, available, "scripts-on-db"),
      );
    }
  }

  // 6. Declared scripts must be strict UTF-8 text.
  const declaredSshScripts = new Set(parsed.frontmatter.scriptsOnSsh ?? []);
  const declaredDbScripts = new Set(parsed.frontmatter.scriptsOnDb ?? []);
  for (const file of files) {
    if (!declaredSshScripts.has(file.path) && !declaredDbScripts.has(file.path)) {
      continue;
    }
    const decoded = readSshScriptSource(file.content);
    if (!decoded.ok) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        declaredSshScripts.has(file.path)
          ? describeUnusableSshScript(file.path, decoded.reason)
          : `${file.path} is not valid UTF-8 or contains NUL bytes; ` +
            "re-save it as UTF-8 before declaring it in scripts-on-db.",
      );
    }
  }

  // 7. Name collision check (per-creator uniqueness) + conflict resolution.
  const conflictStrategy = body.conflictStrategy;
  const existingId = await findOwnedSkillByName(session.user.id, parsed.frontmatter.name);
  const storage = getDbSkillStorage();

  if (existingId && conflictStrategy === "overwrite") {
    await storage.overwriteCustom({
      skillId: existingId,
      skillMd: skillMdText,
      updatedBy: session.user.id,
      files: files.map((f) => ({
        path: f.path,
        content: f.content,
        contentType: guessContentType(f.path) ?? undefined,
      })),
    });

    await invalidateForSkillChange(existingId);

    const [updated] = await db
      .select()
      .from(SkillTable)
      .where(eq(SkillTable.id, existingId))
      .limit(1);

    return NextResponse.json(
      { ...updated, filesImported: files.length, skipped, overwritten: true },
      { status: 200 },
    );
  }

  if (conflictStrategy === "rename") {
    let targetName = body.customName;
    if (targetName) {
      if (!isValidSkillName(targetName)) {
        throw new ApiError(
          "VALIDATION_FAILED",
          400,
          `Skill name must be a kebab-case slug (a-z, 0-9, -, _; up to 64 chars). Got: ${targetName}`,
        );
      }
      const takenId = await findOwnedSkillByName(session.user.id, targetName);
      if (takenId) {
        throw new ApiError(
          "CONFLICT",
          409,
          `You already own a skill named "${targetName}".`,
          { existingId: takenId, existingName: targetName },
        );
      }
    } else if (existingId) {
      let candidate: string | null = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const suffix = `_${randomDigits(attempt < 8 ? 3 : 5)}`;
        const next = buildSuffixedSkillName(parsed.frontmatter.name, suffix);
        if (!(await findOwnedSkillByName(session.user.id, next))) {
          candidate = next;
          break;
        }
      }
      if (!candidate) {
        throw new ApiError(
          "CONFLICT",
          409,
          `Could not allocate a unique name for "${parsed.frontmatter.name}".`,
        );
      }
      targetName = candidate;
    }

    if (targetName && targetName !== parsed.frontmatter.name) {
      skillMdText = rewriteSkillNameInSkillMd(skillMdText, targetName);
      parsed = parseSkillMd(skillMdText);
    }
  } else if (existingId) {
    const boundRows = await db
      .select({ id: BuiltinAgentToolTable.id })
      .from(BuiltinAgentToolTable)
      .where(eq(BuiltinAgentToolTable.skillId, existingId));
    throw new ApiError(
      "CONFLICT",
      409,
      `You already own a skill named "${parsed.frontmatter.name}".`,
      {
        existingId,
        existingName: parsed.frontmatter.name,
        boundAgentCount: boundRows.length,
      },
    );
  }

  // 8. Persist new skill row + helper files.
  const { id } = await storage.createCustom({
    skillMd: skillMdText,
    visibility: "private",
    createdBy: session.user.id,
  });

  for (const f of files) {
    await storage.putFile({
      skillId: id,
      path: f.path,
      content: f.content,
      contentType: guessContentType(f.path) ?? undefined,
    });
  }

  // 9. Cache invalidation.
  await invalidateForSkillChange(id);

  // 10. Return the created row.
  const [row] = await db
    .select()
    .from(SkillTable)
    .where(eq(SkillTable.id, id))
    .limit(1);

  return NextResponse.json(
    { ...row, filesImported: files.length, skipped },
    { status: 201 },
  );
});
