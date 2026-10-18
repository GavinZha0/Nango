/**
 * POST /api/skills/import — import a .skill (ZIP) archive as a custom skill.
 *
 * Processing is entirely in-memory (no temp files). Security properties:
 * - Content-Length hard cap (10 MB)
 * - Symlink rejection via ZIP external_attr
 * - Path traversal impossible (skill_file.path is a string column, not fs)
 * - Zip-bomb mitigation via per-entry uncompressed size tracking
 *
 * See docs/skills.md.
 */

import "server-only";

import { NextResponse } from "next/server";
import JSZip from "jszip";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { invalidateForSkillChange } from "@/lib/cache/invalidation";
import {
  parseSkillMd,
  SkillParseError,
  findMissingSshScripts,
  describeMissingSshScripts,
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

const ROUTE = "/api/skills/import";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Unix mode mask for file type; symlink = 0xA000. */
const S_IFMT = 0xF000;
const S_IFLNK = 0xA000;

/** SKILL.md must be at root or inside a single top-level folder. */
function locateSkillMd(
  files: Record<string, JSZip.JSZipObject>,
): JSZip.JSZipObject | null {
  // Try root first
  if (files["SKILL.md"]) return files["SKILL.md"];

  // Try single nested folder (e.g. my-skill/SKILL.md)
  const candidates = Object.keys(files).filter(
    (p) => p.endsWith("/SKILL.md") && p.split("/").length === 2,
  );
  if (candidates.length === 1) return files[candidates[0]];
  return null;
}

/** Derive the prefix to strip from file paths when the SKILL.md is
 *  inside a nested folder (e.g. "my-skill/" → strip "my-skill/"). */
function derivePrefix(skillMdPath: string): string {
  const idx = skillMdPath.lastIndexOf("/");
  return idx === -1 ? "" : skillMdPath.slice(0, idx + 1);
}

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  // 1. Read upload body with size guard.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      "BAD_REQUEST",
      413,
      `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
    );
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    throw new ApiError("BAD_REQUEST", 400, "Missing 'file' field in form data.");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      "BAD_REQUEST",
      413,
      `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
    );
  }

  // 2. Parse ZIP.
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ApiError("BAD_REQUEST", 400, "Invalid ZIP archive.");
  }

  // 3. Locate SKILL.md.
  const skillMdEntry = locateSkillMd(zip.files);
  if (!skillMdEntry) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "ZIP must contain a SKILL.md at the root or inside a single top-level folder.",
    );
  }
  const prefix = derivePrefix(skillMdEntry.name);

  // 4. Validate entries + collect files.
  const filesToWrite: Array<{ path: string; content: Buffer }> = [];
  let totalUncompressedBytes = 0;

  for (const [rawPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;

    // Security: reject symlinks via Unix mode bits.
    const unixMode = (entry.unixPermissions ?? 0) as number;
    if ((unixMode & S_IFMT) === S_IFLNK) {
      throw new ApiError("BAD_REQUEST", 400, `Symlink rejected: ${rawPath}`);
    }

    // Security: reject path traversal patterns.
    if (rawPath.includes("..") || rawPath.includes("\\") || rawPath.startsWith("/")) {
      throw new ApiError("BAD_REQUEST", 400, `Invalid path in archive: ${rawPath}`);
    }

    // Strip prefix (for nested-folder archives).
    if (!rawPath.startsWith(prefix)) continue;
    const relativePath = rawPath.slice(prefix.length);
    if (!relativePath || relativePath === "SKILL.md") continue;

    // Any folder name is legal; what gets skipped here is archive noise —
    // root-level files and dotfiles, which are not skill content.
    try {
      validateSkillFilePath(relativePath);
    } catch (err) {
      if (err instanceof InvalidSkillPathError) continue;
      throw err;
    }

    // Extract content with size tracking (zip-bomb mitigation).
    const content = Buffer.from(await entry.async("nodebuffer"));
    totalUncompressedBytes += content.length;

    if (content.length > MAX_FILE_BYTES()) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `File ${relativePath} exceeds ${MAX_FILE_BYTES() / 1024} KB limit.`,
      );
    }
    if (totalUncompressedBytes > MAX_TOTAL_BYTES_PER_SKILL()) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `Total uncompressed size exceeds ${MAX_TOTAL_BYTES_PER_SKILL() / 1024 / 1024} MB limit.`,
      );
    }
    if (filesToWrite.length >= MAX_FILES_PER_SKILL()) {
      throw new ApiError(
        "BAD_REQUEST",
        413,
        `Archive exceeds ${MAX_FILES_PER_SKILL()} file limit.`,
      );
    }

    filesToWrite.push({ path: relativePath, content });
  }

  // 5. Parse and validate SKILL.md.
  const skillMdText = await skillMdEntry.async("string");
  let parsed;
  try {
    parsed = parseSkillMd(skillMdText);
  } catch (err) {
    if (err instanceof SkillParseError) {
      throw new ApiError("VALIDATION_FAILED", 400, err.message);
    }
    throw err;
  }

  // 5b. scripts-on-ssh entries must be backed by a file in this same bundle.
  // The bundle is fully in memory here, so this is decidable before any write
  // — rejecting later would leave a dangling declaration that only blows up at
  // run time as SCRIPT_NOT_FOUND.
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

  // 5c. Declared scripts must be strict UTF-8 text. Their source is embedded
  // in a command string shipped to a remote host, where a mangled byte
  // executes as mojibake; rejecting here is the last point where the author
  // can still re-save the file.
  const declaredSshScripts = new Set(parsed.frontmatter.scriptsOnSsh ?? []);
  for (const file of filesToWrite) {
    if (!declaredSshScripts.has(file.path)) continue;
    const decoded = readSshScriptSource(file.content);
    if (!decoded.ok) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        describeUnusableSshScript(file.path, decoded.reason),
      );
    }
  }

  // 6. Name collision check (per-creator uniqueness).
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

  // 7. Persist skill row + helper files in one logical write.
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

  // 8. Cache invalidation.
  await invalidateForSkillChange(id);

  // 9. Return created row.
  const [row] = await db
    .select()
    .from(SkillTable)
    .where(eq(SkillTable.id, id))
    .limit(1);

  return NextResponse.json(
    { ...row, filesImported: filesToWrite.length },
    { status: 201 },
  );
});
