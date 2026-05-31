/**
 * collect-skill-deps — generate `docker/sandbox/requirements.txt` from
 * builtin skill frontmatter `dependencies-python` declarations.
 *
 * Source: every `<repo>/skills/<name>/SKILL.md` parsed for the
 * `dependencies-python` field.
 *
 * Sink:   `docker/sandbox/requirements.txt`, grouped by source skill
 *         (with comment headers) for diff readability.
 *
 * Modes:
 *   - default (write): generate / overwrite the requirements file.
 *   - --check         : exit non-zero if the on-disk file does NOT
 *                       match what would be generated. Used by CI to
 *                       prevent a SKILL.md edit from drifting away
 *                       from the committed requirements.txt.
 *
 * Pure logic (merge / conflict detect / render) lives in
 * `src/lib/skills/dep-aggregation.ts` so it can be unit-tested
 * without spawning this script. This file is only fs IO + CLI glue.
 *
 * Scope: builtin skills only. User skills (DB / `$NANGO_SKILLS_HOME`)
 * are NOT scanned — their declarations are advisory until they're
 * promoted to builtin via PR.
 *
 * See docs/skills.md.x for the full design rationale.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseSkillMd, SkillParseError } from "@/lib/skills/parser";
import {
  declaredDep,
  mergeDeps,
  renderRequirements,
  type SkillDeps,
} from "@/lib/skills/dep-aggregation";

const REPO_ROOT: string = path.resolve(process.cwd());
const SKILLS_ROOT: string = path.join(REPO_ROOT, "skills");
const REQUIREMENTS_PATH: string = path.join(
  REPO_ROOT,
  "docker",
  "sandbox",
  "requirements.txt",
);

async function listSkillDirs(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

async function readSkillDeps(skillName: string): Promise<SkillDeps | null> {
  const skillMdPath: string = path.join(SKILLS_ROOT, skillName, "SKILL.md");
  let raw: string;
  try {
    raw = await fs.readFile(skillMdPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const parsed = parseSkillMd(raw);
  const declared: string[] = parsed.frontmatter.dependenciesPython ?? [];
  const source: string = path.relative(REPO_ROOT, skillMdPath);
  return {
    skillName,
    deps: declared
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((spec) => declaredDep(spec, source)),
  };
}

async function main(): Promise<void> {
  const checkMode: boolean = process.argv.includes("--check");

  const skillNames: string[] = await listSkillDirs(SKILLS_ROOT);
  const perSkill: SkillDeps[] = [];
  for (const name of skillNames) {
    try {
      const sd: SkillDeps | null = await readSkillDeps(name);
      if (sd) perSkill.push(sd);
    } catch (err) {
      if (err instanceof SkillParseError) {
        process.stderr.write(
          `[collect-skill-deps] skipping skills/${name}: ${err.message}\n`,
        );
        continue;
      }
      throw err;
    }
  }

  const merged = mergeDeps(perSkill);
  const generated: string = renderRequirements(merged);

  if (checkMode) {
    let onDisk: string = "";
    try {
      onDisk = await fs.readFile(REQUIREMENTS_PATH, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (onDisk !== generated) {
      process.stderr.write(
        `[collect-skill-deps] DRIFT: docker/sandbox/requirements.txt is out of date.\n` +
          `Run \`pnpm sandbox:build\` to regenerate, then commit the result.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      "[collect-skill-deps] requirements.txt is up to date.\n",
    );
    return;
  }

  await fs.mkdir(path.dirname(REQUIREMENTS_PATH), { recursive: true });
  await fs.writeFile(REQUIREMENTS_PATH, generated, "utf8");
  const totalPackages: number = generated
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("#")).length;
  process.stdout.write(
    `[collect-skill-deps] wrote ${path.relative(REPO_ROOT, REQUIREMENTS_PATH)} (${totalPackages} packages from ${perSkill.length} skill${perSkill.length === 1 ? "" : "s"} scanned).\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[collect-skill-deps] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
