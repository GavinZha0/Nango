/**
 * Keep `scripts-on-ssh` declarations in step with file renames/deletes.
 *
 * Server-side only because callers parse the stored SKILL.md first; the
 * underlying rewrite helper in `parser.ts` is shared with tests.
 *
 * @see docs/skills.md
 */

import "server-only";

import { isExecutableFileName } from "@/lib/skills/file-rules";
import { parseSkillMd, rewriteScriptsOnSshInSkillMd } from "@/lib/skills/parser";

export interface SkillMdSyncResult {
  skillMd: string;
  changed: boolean;
  /** Set when rewrite would duplicate an existing declaration. */
  conflict?: boolean;
  /** Non-blocking note for the UI (e.g. non-executable target). */
  warning?: string;
}

/**
 * Rewrite a declaration after renaming one file.
 *
 * Returns `changed: false` when the old path was never declared, so non-script
 * files do not require a parseable SKILL.md.
 */
export function syncDeclarationForRename(
  skillMd: string,
  oldPath: string,
  newPath: string,
): SkillMdSyncResult {
  if (oldPath === newPath) return { skillMd, changed: false };
  const parsed = parseSkillMd(skillMd);
  const declared = new Set(parsed.frontmatter.scriptsOnSsh ?? []);
  if (!declared.has(oldPath)) return { skillMd, changed: false };
  if (declared.has(newPath)) {
    return { skillMd, changed: false, conflict: true };
  }

  const rewritten = rewriteScriptsOnSshInSkillMd(
    skillMd,
    new Map([[oldPath, newPath]]),
  );
  return {
    skillMd: rewritten.skillMd,
    changed: rewritten.changed,
    warning: isExecutableFileName(newPath)
      ? undefined
      : `${newPath} is declared in scripts-on-ssh but is not executable; ` +
        "run_skill_script_on_ssh will reject it.",
  };
}

/**
 * Rewrite declarations whose files live under a renamed folder.
 *
 * Declarations support sub-directories under scripts/, so renaming
 * `scripts/lib` must move `scripts/lib/*` entries with the files.
 */
export function syncDeclarationsForFolderRename(
  skillMd: string,
  oldPath: string,
  newPath: string,
): SkillMdSyncResult {
  if (oldPath === newPath) return { skillMd, changed: false };

  const parsed = parseSkillMd(skillMd);
  const declared = parsed.frontmatter.scriptsOnSsh ?? [];
  const prefix = `${oldPath}/`;
  const affected = declared.filter((path) => path.startsWith(prefix));
  if (affected.length === 0) return { skillMd, changed: false };

  const affectedSet = new Set(affected);
  const newPaths = affected.map(
    (path) => `${newPath}${path.slice(oldPath.length)}`,
  );
  const unaffected = declared.filter((path) => !affectedSet.has(path));
  if (newPaths.some((path) => unaffected.includes(path))) {
    return { skillMd, changed: false, conflict: true };
  }

  const updates = new Map<string, string | null>();
  affected.forEach((path, index) => updates.set(path, newPaths[index]));
  const rewritten = rewriteScriptsOnSshInSkillMd(skillMd, updates);
  return { skillMd: rewritten.skillMd, changed: rewritten.changed };
}

/** Remove declarations for every deleted path. */
export function syncDeclarationsForDelete(
  skillMd: string,
  deletedPaths: readonly string[],
): SkillMdSyncResult {
  const parsed = parseSkillMd(skillMd);
  const declared = new Set(parsed.frontmatter.scriptsOnSsh ?? []);
  const updates = new Map<string, string | null>();
  for (const path of deletedPaths) {
    if (declared.has(path)) updates.set(path, null);
  }
  if (updates.size === 0) return { skillMd, changed: false };
  const rewritten = rewriteScriptsOnSshInSkillMd(skillMd, updates);
  return { skillMd: rewritten.skillMd, changed: rewritten.changed };
}
