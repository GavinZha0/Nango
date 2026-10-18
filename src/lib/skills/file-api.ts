/**
 * Validation helpers shared by the skill-file write routes.
 *
 * @see docs/skills.md
 */

import "server-only";

import { ApiError } from "@/lib/http/route-handlers";

import {
  isExecutableFileName,
  isRootSkillMd,
  isValidFileName,
} from "./file-rules";
import {
  classifyEditorCreatePath,
  classifyEditorRenamePath,
  type FilePolicyResult,
} from "./import-policy";
import {
  getDbSkillStorage,
  InvalidSkillPathError,
  validateSkillFilePath,
} from "./storage";

const VALIDATION_ERROR = "VALIDATION_FAILED";

export function assertUserName(name: string): void {
  if (!isValidFileName(name)) {
    throw new ApiError(
      VALIDATION_ERROR,
      400,
      `"${name}" is not a valid file name. Use letters, digits, dot, underscore ` +
        "or hyphen, and do not start with a dot.",
    );
  }
}

export function assertParentFolder(parent: string): void {
  if (!parent) return;
  try {
    validateSkillFilePath(parent);
  } catch (err) {
    if (err instanceof InvalidSkillPathError) {
      throw new ApiError(VALIDATION_ERROR, 400, `Invalid parent folder: ${err.message}`);
    }
    throw err;
  }
}

export function assertSkillPath(path: string): void {
  try {
    validateSkillFilePath(path);
  } catch (err) {
    if (err instanceof InvalidSkillPathError) {
      throw new ApiError(VALIDATION_ERROR, 400, err.message);
    }
    throw err;
  }
}

/**
 * Executable scripts must live under the reserved scripts/ folder.
 *
 * Applies to creation and rename. It deliberately does not restrict other
 * extensions: renaming a declared script to a non-executable name is allowed.
 */
export function assertExecutablePathRule(path: string): void {
  if (isExecutableFileName(path) && !path.startsWith("scripts/")) {
    throw new ApiError(
      VALIDATION_ERROR,
      400,
      `Executable script "${path}" must live under scripts/ (subfolders are allowed).`,
    );
  }
}

/**
 * Text-only UI creation.
 *
 * CONTRACT: binary assets are imported, never authored in the editor.
 */
export function assertEditorCreatePath(path: string): void {
  if (isRootSkillMd(path)) {
    throw new ApiError(
      VALIDATION_ERROR,
      400,
      "SKILL.md is edited as the main document and cannot be created here.",
    );
  }
  const policy = classifyEditorCreatePath(path);
  if (policy.action !== "allow-text") {
    throw new ApiError(
      VALIDATION_ERROR,
      400,
      policy.reason ?? "This file type is not allowed.",
    );
  }
  assertExecutablePathRule(path);
}

/**
 * Rename validation. Text and image files are allowed; blocked/unknown types
 * are refused. The route also checks that the existing bytes match the new
 * type (text vs image magic).
 */
export function assertEditorRenamePath(path: string): FilePolicyResult {
  const policy = classifyEditorRenamePath(path);
  if (policy.action !== "allow-text" && policy.action !== "allow-image") {
    throw new ApiError(
      VALIDATION_ERROR,
      400,
      policy.reason ?? "This file type is not allowed.",
    );
  }
  assertExecutablePathRule(path);
  return policy;
}

/**
 * Reject a path that already names a file, or whose prefix already contains
 * files (i.e. the same name is already a folder). Callers skip this when the
 * path is unchanged.
 */
export async function assertPathFree(skillId: string, path: string): Promise<void> {
  const storage = getDbSkillStorage();
  if (await storage.readFile(skillId, path)) {
    throw new ApiError("CONFLICT", 409, `A file already exists at "${path}".`);
  }
  const files = await storage.listFiles(skillId);
  if (files.some((f) => f.path.startsWith(`${path}/`))) {
    throw new ApiError("CONFLICT", 409, `A folder already exists at "${path}".`);
  }
}

export async function assertParentIsNotFile(
  skillId: string,
  parent: string,
): Promise<void> {
  if (!parent) return;
  const file = await getDbSkillStorage().readFile(skillId, parent);
  if (file) {
    throw new ApiError(
      "CONFLICT",
      409,
      `A file already exists at "${parent}", so it cannot be used as a folder.`,
    );
  }
}

/** Postgres unique_violation; a race may still slip past the pre-check. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
