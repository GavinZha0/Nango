/**
 * Pure file-name rules shared by the skills API and the editor UI.
 * No server-only imports: this module is safe in the client bundle.
 *
 * Path string primitives live in `@/lib/paths`; this module is the skills
 * vocabulary built on top of them.
 *
 * See docs/skills.md.
 */

import { getExtension } from "@/lib/paths";

/** One path segment: alnum/underscore/hyphen first, then dots allowed. */
export const FILE_NAME_PATTERN = /^[A-Za-z0-9_\-][A-Za-z0-9._\-]*$/;

export function isValidFileName(name: string): boolean {
  return FILE_NAME_PATTERN.test(name);
}

/** V1 interpreters: python3 and bash only. */
export function isExecutableFileName(name: string): boolean {
  const ext = getExtension(name);
  return ext === "py" || ext === "sh";
}

/** A file path is executable only when it lives under the reserved scripts/. */
export function isUnderScripts(path: string): boolean {
  return path.startsWith("scripts/");
}

export function isRootSkillMd(path: string): boolean {
  return path.toLowerCase() === "skill.md";
}

export function joinSkillPath(parent: string, name: string): string {
  return parent.length > 0 ? `${parent}/${name}` : name;
}

/** The reserved top-level scripts/ folder itself (not its children). */
export function isScriptsFolder(path: string): boolean {
  return path === "scripts";
}
