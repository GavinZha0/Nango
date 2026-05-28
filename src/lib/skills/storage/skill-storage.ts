/**
 * SkillStorage — interface every skill backend implements.
 */

import type { Session } from "@/lib/http/route-handlers";

// Domain types

export type SkillSource = "builtin" | "local";
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
  source: SkillSource;
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
  /** Caller's user id; persisted as `createdBy`. */
  createdBy: string;
}

export interface UpdateSkillContentInput {
  skillId: string;
  skillMd: string;
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

// Storage interface

export interface SkillStorage {
  // Read
  loadSkill(skillId: string): Promise<SkillRecord | null>;
  /** Skills visible to the calling session (own + public + admin-all). */
  listVisible(session: Session): Promise<SkillRecord[]>;
  /** Read a helper file. Returns null if path is not in this skill. */
  readFile(skillId: string, path: string): Promise<SkillFileRecord | null>;
  listFiles(skillId: string): Promise<SkillFileMeta[]>;

  // Write (custom skills only — `source = 'builtin'` is rejected at the API edge)
  createCustom(input: CreateCustomSkillInput): Promise<{ id: string }>;
  updateContent(input: UpdateSkillContentInput): Promise<void>;
  updateFlags(input: UpdateSkillFlagsInput): Promise<void>;
  delete(skillId: string): Promise<void>;
  putFile(input: PutSkillFileInput): Promise<void>;
  deleteFile(skillId: string, path: string): Promise<void>;
}

// Path validation (shared helper)

const ALLOWED_PREFIXES = ["references", "scripts", "assets", "evals"] as const;
/** path-segment chars: alnum, dot, underscore, hyphen — and no leading dot. */
const PATH_REGEX =
  /^(references|scripts|assets|evals)\/(?:[A-Za-z0-9_\-][A-Za-z0-9._\-]*)(?:\/[A-Za-z0-9_\-][A-Za-z0-9._\-]*)*$/;
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
 * to traverse, so this is a pure string check. Rejects:
 *   - empty / oversize paths
 *   - back-slashes, absolute paths, `..` segments
 *   - top-level segment outside {references, scripts, assets, evals}
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
  if (!PATH_REGEX.test(path)) {
    throw new InvalidSkillPathError(
      `Path must start with one of ${ALLOWED_PREFIXES.join("/, ")}/.`,
    );
  }
}

// Caps (shared between API validation and bundle build)

import { getConfigNumber } from "@/lib/config";

export const MAX_FILE_BYTES = (): number => getConfigNumber("skill.max_file_bytes", 256 * 1024);
export const MAX_FILES_PER_SKILL = (): number => getConfigNumber("skill.max_files", 100);
export const MAX_TOTAL_BYTES_PER_SKILL = (): number => getConfigNumber("skill.max_total_bytes", 10 * 1024 * 1024);
