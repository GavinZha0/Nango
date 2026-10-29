/**
 * SkillStorage — interface every skill backend implements.
 */

import type { Session } from "@/lib/http/route-handlers";

// Domain types

export type SkillVisibility = "private" | "public";

/**
 * Cached projection of a single skill row, as consumed by runtime tools
 * and the agent pool. Mirrors the shape of `SkillSpec` in `skill-pool.ts`
 * but sourced directly from DB.
 */
export interface SkillRecord {
  skillId: string;
  name: string;
  description: string | null;
  /** Frontmatter `version` field (default `"1.0.0"`). */
  version: string;
  /** Full SKILL.md text (frontmatter + body). */
  skillMd: string;
  enabled: boolean;
  visibility: SkillVisibility;
  /** Original creator; null after hard-purge of that user (FK SET NULL). */
  createdBy: string | null;
  /** Last user who modified this row; null until first PATCH. */
  updatedBy: string | null;
}

/**
 * Single helper file as returned by `readFile`. `content` is the raw
 * bytes; the caller decides whether to base64-encode for transport.
 */
export interface SkillFileRecord {
  skillId: string;
  path: string;
  content: Buffer;
  size: number;
  contentType: string | null;
}

/** Lightweight metadata-only file record (no content load). */
export interface SkillFileMeta {
  path: string;
  size: number;
  contentType: string | null;
}

// Write inputs

export interface CreateCustomSkillInput {
  /** Verbatim SKILL.md text. Frontmatter `name` becomes the row's name. */
  skillMd: string;
  visibility?: SkillVisibility;
  /** Free-form origin label ("" = unlabeled). */
  source?: string;
  /** Caller's user id; persisted as `createdBy`. */
  createdBy: string;
}

export interface UpdateSkillContentInput {
  skillId: string;
  skillMd: string;
  /** Free-form origin label; omit to leave unchanged. */
  source?: string;
  /** Caller's user id; persisted as `updatedBy`. */
  updatedBy: string;
}

export interface UpdateSkillFlagsInput {
  skillId: string;
  enabled?: boolean;
  visibility?: SkillVisibility;
  updatedBy: string;
}

export interface PutSkillFileInput {
  skillId: string;
  path: string;
  content: Buffer;
  contentType?: string;
}

export interface UpdateFileInput {
  skillId: string;
  oldPath: string;
  newPath: string;
  /** New bytes; omit to leave the file content untouched. */
  content?: Buffer;
  contentType?: string | null;
  /** Rewritten SKILL.md to persist in the same transaction. */
  skillMd?: string;
  updatedBy: string;
}

export interface RenameFolderInput {
  skillId: string;
  oldPath: string;
  newPath: string;
  /** Rewritten SKILL.md (declaration sync) to persist atomically. */
  skillMd?: string;
  updatedBy: string;
}

export interface DeleteFolderInput {
  skillId: string;
  path: string;
  /** Rewritten SKILL.md (declaration removals) to persist atomically. */
  skillMd?: string;
  updatedBy: string;
}

// Storage interface

export interface SkillStorage {
  // Read
  loadSkill(skillId: string): Promise<SkillRecord | null>;
  /** Skills visible to the calling session (own + public + admin-all). */
  listVisible(session: Session): Promise<SkillRecord[]>;
  /** Read a helper file. Returns null if path is not in this skill. */
  readFile(skillId: string, path: string): Promise<SkillFileRecord | null>;
  listFiles(skillId: string): Promise<SkillFileMeta[]>;

  // Write (RBAC and path/caps validation are enforced at the API edge)
  createCustom(input: CreateCustomSkillInput): Promise<{ id: string }>;
  updateContent(input: UpdateSkillContentInput): Promise<void>;
  updateFlags(input: UpdateSkillFlagsInput): Promise<void>;
  delete(skillId: string): Promise<void>;
  putFile(input: PutSkillFileInput): Promise<void>;
  /** Rename and/or replace one file's bytes; optionally sync SKILL.md. */
  updateFile(input: UpdateFileInput): Promise<void>;
  /** Rename every file under a folder prefix. */
  renameFolder(input: RenameFolderInput): Promise<void>;
  deleteFile(
    skillId: string,
    path: string,
    sync?: { skillMd: string; updatedBy: string },
  ): Promise<void>;
  /** Delete every file under a folder prefix. */
  deleteFolder(input: DeleteFolderInput): Promise<void>;
}

// Path validation (shared helper)

/** path-segment chars: alnum, dot, underscore, hyphen — and no leading dot. */
const PATH_REGEX =
  /^[A-Za-z0-9_\-][A-Za-z0-9._\-]*(?:\/[A-Za-z0-9_\-][A-Za-z0-9._\-]*)*$/;
const MAX_PATH_LEN = 256;

export class InvalidSkillPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillPathError";
  }
}

/**
 * Validate a `skill_file.path` string.
 *
 * Path is a logical relative POSIX path; there is no actual filesystem
 * to traverse, so this is a pure string check. Any folder name is accepted
 * — skill authors use `references/`, `lib/`, `rules/`, … — and root-level
 * files such as `LICENSE` are valid. Rejects:
 *   - empty / oversize paths
 *   - back-slashes, absolute paths, `..` segments
 *   - the synthetic root `SKILL.md` (it lives in its own column)
 *   - dotfiles at any segment
 */
export function validateSkillFilePath(path: string): void {
  if (!path || path.length === 0) {
    throw new InvalidSkillPathError("Path must not be empty.");
  }
  if (path.length > MAX_PATH_LEN) {
    throw new InvalidSkillPathError(`Path exceeds ${MAX_PATH_LEN} chars.`);
  }
  if (path.includes("\\") || path.startsWith("/") || path.includes("..")) {
    throw new InvalidSkillPathError(
      "Path must be a relative POSIX path without back-slashes or '..' segments.",
    );
  }
  if (path.toLowerCase() === "skill.md") {
    throw new InvalidSkillPathError(
      "SKILL.md is edited as the skill's main document and cannot be stored as a helper file.",
    );
  }
  if (!PATH_REGEX.test(path)) {
    throw new InvalidSkillPathError(
      "Path must be a relative file path such as references/guide.md or LICENSE.",
    );
  }
}

// Caps (shared between API validation and bundle build)

import { getConfigNumber } from "@/lib/config";

export const MAX_FILE_BYTES = (): number => getConfigNumber("skill.max_file_bytes", 256 * 1024);
export const MAX_FILES_PER_SKILL = (): number => getConfigNumber("skill.max_files", 100);
export const MAX_TOTAL_BYTES_PER_SKILL = (): number => getConfigNumber("skill.max_total_bytes", 10 * 1024 * 1024);
