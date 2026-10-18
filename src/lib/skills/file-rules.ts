/**
 * Pure file-name rules shared by the skills API and the editor UI.
 * No server-only imports: this module is safe in the client bundle.
 *
 * See docs/skills.md.
 */

/** One path segment: alnum/underscore/hyphen first, then dots allowed. */
export const FILE_NAME_PATTERN = /^[A-Za-z0-9_\-][A-Za-z0-9._\-]*$/;

export function getExtension(name: string): string {
  const base = getBaseName(name);
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1
    ? ""
    : base.slice(dot + 1).toLowerCase();
}

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

export function getBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function getParentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function joinSkillPath(parent: string, name: string): string {
  return parent.length > 0 ? `${parent}/${name}` : name;
}

/** The reserved top-level scripts/ folder itself (not its children). */
export function isScriptsFolder(path: string): boolean {
  return path === "scripts";
}
