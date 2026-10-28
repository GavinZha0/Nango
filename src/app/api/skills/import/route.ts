/**
 * POST /api/skills/import — import a folder of files as a custom skill.
 *
 * The browser enumerates the user-picked directory (via `<input
 * webkitdirectory>`) and POSTs a JSON manifest of `{ path, contentBase64 }`
 * entries. There is no archive format, no decompression, and no symlink
 * surface — the server receives already-materialised file bytes, so the only
 * inflation risk is base64 (a fixed 4/3 factor, bounded by the decoded-size
 * cap).
 *
 * Security properties:
 * - Content-Length pre-check + per-entry decoded-size accounting (10 MB total)
 * - Path-traversal / dotfile / absolute-path rejection (never trusts the client)
 * - Text/image allowlist with NUL-byte and image-magic validation
 *
 * See docs/skills.md.
 */

import "server-only";

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { invalidateForSkillChange } from "@/lib/cache/invalidation";
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
  guessContentType,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SKILL,
  MAX_TOTAL_BYTES_PER_SKILL,
} from "@/lib/skills/storage/skill-storage";
import {
  classifyImportPath,
  validateImageBytes,
  validateTextBytes,
} from "@/lib/skills/import-policy";

const ROUTE = "/api/skills/import";

// Request-body ceiling. base64 is a fixed 4/3 factor over the 10 MB decoded
// cap, plus JSON path overhead — 16 MB leaves comfortable headroom while
// still rejecting a hostile multi-hundred-MB body before `req.json()` reads it.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const folderEntrySchema = z.object({
  path: z.string().min(1).max(256),
  contentBase64: z.string().min(1),
});

const importFolderSchema = z
  .object({
    entries: z.array(folderEntrySchema).min(1).max(1000),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  // 1. Reject an oversized body before buffering it.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new ApiError(
      "BAD_REQUEST",
      413,
      `Upload exceeds ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB.`,
    );
  }

  const body = await parseBody(req, importFolderSchema);

  // 2. Walk the entries: locate SKILL.md, classify the rest, and enforce the
  //    same policy + caps every other skill-file write applies.
  let skillMdText: string | null = null;
  const filesToWrite: Array<{ path: string; content: Buffer }> = [];
  const skipped: string[] = [];
  const blocked: Array<{ path: string; reason: string }> = [];
  let totalDecodedBytes = 0;

  for (const entry of body.entries) {
    const { path } = entry;

    // SKILL.md lives at the folder root and is stored in the skill row.
    if (path === "SKILL.md") {
      skillMdText = Buffer.from(entry.contentBase64, "base64").toString("utf-8");
      continue;
    }

    // SECURITY: never trust the client — a crafted client can send `..`,
    // back-slashes, or absolute paths even though the real directory picker
    // cannot. Reject outright, before classification.
    if (path.includes("..") || path.includes("\\") || path.startsWith("/")) {
      throw new ApiError("BAD_REQUEST", 400, `Invalid path in upload: ${path}`);
    }

    // Classify before path validation: dotfiles are folder noise (skipped),
    // while `validateSkillFilePath` would reject their leading dot as invalid.
    const policy = classifyImportPath(path);
    if (policy.action === "ignore") {
      skipped.push(path);
      continue;
    }
    if (policy.action === "block") {
      blocked.push({ path, reason: policy.reason ?? "unsupported file type" });
      continue;
    }

    try {
      validateSkillFilePath(path);
    } catch (err) {
      if (err instanceof InvalidSkillPathError) {
        blocked.push({ path, reason: "invalid path" });
        continue;
      }
      throw err;
    }

    // Count cap before decoding so a hostile thousand-entry body fails fast
    // without allocating a Buffer for each one.
    if (filesToWrite.length >= MAX_FILES_PER_SKILL()) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `Upload exceeds ${MAX_FILES_PER_SKILL()} file limit.`,
      );
    }

    const content = Buffer.from(entry.contentBase64, "base64");
    totalDecodedBytes += content.length;

    if (content.length > MAX_FILE_BYTES()) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `File ${path} exceeds ${MAX_FILE_BYTES() / 1024} KB limit.`,
      );
    }
    if (totalDecodedBytes > MAX_TOTAL_BYTES_PER_SKILL()) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `Total size exceeds ${MAX_TOTAL_BYTES_PER_SKILL() / 1024 / 1024} MB limit.`,
      );
    }

    if (policy.action === "allow-text") {
      const textError = validateTextBytes(content);
      if (textError) {
        blocked.push({ path, reason: textError });
        continue;
      }
    } else if (policy.action === "allow-image") {
      const imageError = validateImageBytes(path, content);
      if (imageError) {
        blocked.push({ path, reason: imageError });
        continue;
      }
    }

    filesToWrite.push({ path, content });
  }

  if (blocked.length > 0) {
    const shown = blocked
      .slice(0, 20)
      .map((entry) => `"${entry.path}" (${entry.reason})`)
      .join(", ");
    const more =
      blocked.length > 20 ? ` and ${blocked.length - 20} more` : "";
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Import rejected: ${shown}${more}.`,
    );
  }

  // 3. A single path cannot be both a file and a folder.
  const pathSet = new Set(filesToWrite.map((f) => f.path));
  for (const file of filesToWrite) {
    const segments = file.path.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      if (pathSet.has(prefix)) {
        throw new ApiError(
          "BAD_REQUEST",
          400,
          `Upload contains both a file and a folder named "${prefix}".`,
        );
      }
    }
  }

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
    const available = filesToWrite.map((f) => f.path);
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
    const available = filesToWrite.map((f) => f.path);
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
  for (const file of filesToWrite) {
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

  for (const f of filesToWrite) {
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
    { ...row, filesImported: filesToWrite.length, skipped },
    { status: 201 },
  );
});
