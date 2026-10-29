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

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
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

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  // 1. Reject an oversized body before buffering it.
  assertBodyWithinCap(req, MAX_REQUEST_BYTES);

  const body = await parseBody(req, folderManifestSchema);

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

  // 7. Name collision check (per-creator uniqueness).
  const existing = await db
    .select({ id: SkillTable.id })
    .from(SkillTable)
    .where(
      and(
        eq(SkillTable.name, parsed.frontmatter.name),
        eq(SkillTable.createdBy, session.user.id),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new ApiError(
      "CONFLICT",
      409,
      `You already own a skill named "${parsed.frontmatter.name}".`,
    );
  }

  // 8. Persist skill row + helper files.
  const storage = getDbSkillStorage();
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
