/**
 * build-skills — emit `dist/builtin-skills.json` from `<repo>/skills/`.
 *
 * Authoring view: developer-friendly directory tree under `<repo>/skills/`.
 * Runtime view  : DB rows seeded from this bundle at boot.
 *
 * Run:  pnpm build:skills   (also wired into `prebuild`)
 *
 * @see docs/skills.md §3 — published pipeline
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseSkillMd, SkillParseError } from "@/lib/skills/parser";
import {
  InvalidSkillPathError,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SKILL,
  MAX_TOTAL_BYTES_PER_SKILL,
  validateSkillFilePath,
} from "@/lib/skills/storage/skill-storage";

const ALLOWED_SUBDIRS = ["references", "scripts", "assets", "evals"] as const;
const SKIP_NAMES = new Set([".DS_Store", "__MACOSX", "node_modules", ".git"]);

type FileEncoding = "utf8" | "base64";

interface BundleFile {
  path: string;
  size: number;
  contentType: string | null;
  encoding: FileEncoding;
  content: string;
}

interface BundleSkill {
  name: string;
  version: string;
  description: string;
  checksum: string;
  skillMd: string;
  files: BundleFile[];
}

export interface SkillsBundle {
  $schema: "nango/builtin-skills@1";
  generatedAt: string;
  skills: BundleSkill[];
}

const repoRoot: string = path.resolve(process.cwd());
const skillsRoot: string = path.join(repoRoot, "skills");
const outputPath: string = path.join(repoRoot, "dist", "builtin-skills.json");

async function main(): Promise<void> {
  const dirs: string[] = await listSkillDirs(skillsRoot);
  const skills: BundleSkill[] = [];
  for (const dirName of dirs) {
    const dirAbs: string = path.join(skillsRoot, dirName);
    try {
      const skill: BundleSkill | null = await buildSkill(dirAbs, dirName);
      if (skill) skills.push(skill);
    } catch (err) {
      const reason: string = err instanceof Error ? err.message : String(err);
      throw new Error(`[build-skills] ${dirName}: ${reason}`);
    }
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const bundle: SkillsBundle = {
    $schema: "nango/builtin-skills@1",
    generatedAt: new Date().toISOString(),
    skills,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  const totalFiles: number = skills.reduce((n, s) => n + s.files.length, 0);
  console.log(
    `[build-skills] wrote ${skills.length} skill(s), ${totalFiles} file(s) → ${path.relative(repoRoot, outputPath)}`,
  );
}

async function listSkillDirs(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code: string | undefined = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP_NAMES.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    dirs.push(e.name);
  }
  dirs.sort();
  return dirs;
}

async function buildSkill(
  dirAbs: string,
  dirName: string,
): Promise<BundleSkill | null> {
  const skillMdPath: string = path.join(dirAbs, "SKILL.md");
  let skillMd: string;
  try {
    skillMd = await fs.readFile(skillMdPath, "utf8");
  } catch (err) {
    const code: string | undefined = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.warn(
        `[build-skills] skip "${dirName}" (no SKILL.md at ${path.relative(repoRoot, skillMdPath)})`,
      );
      return null;
    }
    throw err;
  }

  let parsed: ReturnType<typeof parseSkillMd>;
  try {
    parsed = parseSkillMd(skillMd);
  } catch (err) {
    if (err instanceof SkillParseError) {
      throw new Error(`SKILL.md parse failed — ${err.message}`);
    }
    throw err;
  }

  if (parsed.frontmatter.name !== dirName) {
    throw new Error(
      `frontmatter name "${parsed.frontmatter.name}" does not match directory name "${dirName}"`,
    );
  }

  const files: BundleFile[] = await collectFiles(dirAbs, dirName);
  enforceTotals(dirName, files);

  const checksum: string = computeChecksum(skillMd, files);
  return {
    name: parsed.frontmatter.name,
    version: parsed.frontmatter.version,
    description: parsed.frontmatter.description,
    checksum,
    skillMd,
    files,
  };
}

async function collectFiles(
  skillAbs: string,
  dirName: string,
): Promise<BundleFile[]> {
  const out: BundleFile[] = [];
  for (const sub of ALLOWED_SUBDIRS) {
    const subAbs: string = path.join(skillAbs, sub);
    let exists: boolean = true;
    try {
      const stat = await fs.stat(subAbs);
      if (!stat.isDirectory()) exists = false;
    } catch (err) {
      const code: string | undefined = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") exists = false;
      else throw err;
    }
    if (!exists) continue;
    await walkInto(subAbs, sub, out, dirName);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function walkInto(
  dirAbs: string,
  relPrefix: string,
  out: BundleFile[],
  dirName: string,
): Promise<void> {
  const entries: import("node:fs").Dirent[] = await fs.readdir(dirAbs, {
    withFileTypes: true,
  });
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    const childAbs: string = path.join(dirAbs, e.name);
    const childRel: string = `${relPrefix}/${e.name}`;
    if (e.isDirectory()) {
      await walkInto(childAbs, childRel, out, dirName);
      continue;
    }
    if (!e.isFile()) continue;

    try {
      validateSkillFilePath(childRel);
    } catch (err) {
      if (err instanceof InvalidSkillPathError) {
        throw new Error(`invalid skill file path "${childRel}": ${err.message}`);
      }
      throw err;
    }

    const buf: Buffer = await fs.readFile(childAbs);
    if (buf.byteLength > MAX_FILE_BYTES()) {
      throw new Error(
        `${childRel} exceeds per-file cap of ${MAX_FILE_BYTES()} bytes (${buf.byteLength} bytes)`,
      );
    }
    const isText: boolean = isLikelyText(buf);
    out.push({
      path: childRel,
      size: buf.byteLength,
      contentType: guessContentType(childRel, isText),
      encoding: isText ? "utf8" : "base64",
      content: isText ? buf.toString("utf8") : buf.toString("base64"),
    });
  }
}

function enforceTotals(dirName: string, files: BundleFile[]): void {
  if (files.length > MAX_FILES_PER_SKILL()) {
    throw new Error(
      `${dirName} exceeds file-count cap (${files.length} > ${MAX_FILES_PER_SKILL()})`,
    );
  }
  const total: number = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES_PER_SKILL()) {
    throw new Error(
      `${dirName} exceeds total-size cap (${total} > ${MAX_TOTAL_BYTES_PER_SKILL()} bytes)`,
    );
  }
}

/**
 * Canonical checksum: sha256(skillMd-bytes || NUL || join(file.path NUL size NUL bytes, NUL)).
 * Files are pre-sorted by path. Independent of bundle field order.
 */
function computeChecksum(skillMd: string, files: BundleFile[]): string {
  const h = createHash("sha256");
  h.update(Buffer.from(skillMd, "utf8"));
  h.update(Buffer.from([0]));
  for (const f of files) {
    h.update(Buffer.from(f.path, "utf8"));
    h.update(Buffer.from([0]));
    h.update(Buffer.from(String(f.size), "utf8"));
    h.update(Buffer.from([0]));
    const raw: Buffer =
      f.encoding === "utf8"
        ? Buffer.from(f.content, "utf8")
        : Buffer.from(f.content, "base64");
    h.update(raw);
    h.update(Buffer.from([0]));
  }
  return `sha256:${h.digest("hex")}`;
}

function isLikelyText(buf: Buffer): boolean {
  const slice: Buffer = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  return !slice.includes(0);
}

const EXT_TO_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function guessContentType(p: string, isText: boolean): string | null {
  const ext: string = path.extname(p).toLowerCase();
  const mime: string | undefined = EXT_TO_MIME[ext];
  if (mime) return mime;
  return isText ? "text/plain" : null;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
