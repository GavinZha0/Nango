/**
 * Pure path algebra for knowledge pages: legality, folder derivation and
 * prefix rewrites.
 *
 * Folders are implicit path prefixes — there is no folder row — so every "which
 * folder is this, what folders exist, move this subtree" question is answered by
 * string arithmetic instead of by a join. Deliberately free of `server-only`:
 * the editor validates a path with the same rules the service enforces.
 *
 * See docs/kb.md.
 */

import { getParentPath } from "@/lib/paths";
import { alphabeticCompare } from "@/lib/utils/sort";
import { MAX_FOLDER_DEPTH, MAX_PATH_CHARS } from "@/lib/kb/limits";

/**
 * A page path is prose, so there is no character class to match against —
 * Chinese, spaces and dots are all legal. Forbidden instead is anything that
 * makes a segment ambiguous (`//`, `.`/`..`, a leading or trailing slash) or
 * that cannot survive a prompt-block line and a URL segment (control bytes,
 * which also covers NUL).
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Why this string is not a legal list of path segments; null when it is. */
function segmentProblem(path: string): string | null {
  if (path === "") return "must not be empty";
  if (path.length > MAX_PATH_CHARS) {
    return `must not exceed ${MAX_PATH_CHARS} characters`;
  }
  if (CONTROL_CHARS.test(path)) {
    return "must not contain control characters";
  }
  for (const segment of path.split("/")) {
    if (segment === "") return "must not contain an empty segment";
    if (segment === "." || segment === "..") {
      return `must not contain the segment "${segment}"`;
    }
  }
  return null;
}

/** Folder levels a prefix spans: "" is the collection root, so depth 0. */
export function folderDepth(folder: string): number {
  return folder === "" ? 0 : folder.split("/").length;
}

function depthProblem(folder: string): string | null {
  const depth: number = folderDepth(folder);
  return depth > MAX_FOLDER_DEPTH
    ? `nests ${depth} folder levels; the limit is ${MAX_FOLDER_DEPTH}`
    : null;
}

/** Why this is not a legal page path; null when it is. */
export function pathProblem(path: string): string | null {
  return segmentProblem(path) ?? depthProblem(getParentPath(path));
}

/**
 * Why this is not a legal folder prefix; null when it is. The empty string is
 * the collection root and is legal, which is what makes a page path with no
 * slash a root page.
 */
export function folderProblem(folder: string): string | null {
  return folder === "" ? null : (segmentProblem(folder) ?? depthProblem(folder));
}

/** The folder a page path sits in; "" = the collection root. */
export function folderOf(path: string): string {
  return getParentPath(path);
}

/** Every folder a page path passes through, outermost first: `a/b/c.md` → `a`, `a/b`. */
export function ancestorFolders(path: string): string[] {
  const out: string[] = [];
  let cursor: string = getParentPath(path);
  while (cursor !== "") {
    out.unshift(cursor);
    cursor = getParentPath(cursor);
  }
  return out;
}

/**
 * The folders a page set implies, deduplicated and ordered as the tree renders
 * them: parent before child, siblings by {@link alphabeticCompare}.
 *
 * A parent still precedes its children after the locale-aware sort because the
 * parent's string is a strict prefix of theirs.
 */
export function distinctFolders(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    for (const folder of ancestorFolders(path)) seen.add(folder);
  }
  return [...seen].sort(alphabeticCompare);
}

/** Level-1 folders — the count the collection list prints beside its name. */
export function topLevelFolderCount(paths: Iterable<string>): number {
  const seen = new Set<string>();
  for (const path of paths) {
    const folder: string = getParentPath(path);
    if (folder !== "") seen.add(folder.split("/")[0]);
  }
  return seen.size;
}

export function isUnderFolder(path: string, folder: string): boolean {
  return folder !== "" && path.startsWith(`${folder}/`);
}

/**
 * The path a page takes when `oldFolder` becomes `newFolder`. Returns the input
 * unchanged when the page is not under that folder, so a caller can map a whole
 * page set through it and keep the rows the rewrite does not touch.
 */
export function rewriteFolderPrefix(
  path: string,
  oldFolder: string,
  newFolder: string,
): string {
  if (!isUnderFolder(path, oldFolder)) return path;
  const rest: string = path.slice(oldFolder.length + 1);
  return newFolder === "" ? rest : `${newFolder}/${rest}`;
}
