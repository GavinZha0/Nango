/**
 * migrate-skills-to-db — one-shot copy of on-disk skill helper files
 * into the `skill_file` table.
 *
 * Idempotent. Re-runs converge to the same DB state.
 *
 *   - Walks `$NANGO_SKILLS_HOME ?? <cwd>/skills`.
 *   - For each directory with a valid SKILL.md:
 *       * if a matching `skill` row exists (by `path`), we keep its id;
 *       * otherwise INSERT a `source='local'` row owned by the oldest
 *         admin (or the user passed via `--owner=<userId>`).
 *       * `skill_file` rows are **replaced** for each skill in a
 *         transaction (delete-all then insert-all). This mirrors the
 *         builtin reconcile logic and keeps the script crash-safe.
 *   - Built-in skills (rows with `source='builtin'`) are NEVER touched
 *     here — they're owned by `pnpm build:skills` + boot reconcile.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-skills-to-db.ts             # migrate all
 *   pnpm tsx scripts/migrate-skills-to-db.ts --dry-run   # report only
 *   pnpm tsx scripts/migrate-skills-to-db.ts --owner=<uuid>
 *
 * See docs/skills.md.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as dotenv from "dotenv";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SkillTable, SkillFileTable, UserTable } from "@/lib/db/schema";
import { parseSkillMd, SkillParseError } from "@/lib/skills/parser";
import {
  InvalidSkillPathError,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SKILL,
  MAX_TOTAL_BYTES_PER_SKILL,
  validateSkillFilePath,
} from "@/lib/skills/storage/skill-storage";

dotenv.config({ path: ".env" });

const ALLOWED_SUBDIRS = ["references", "scripts", "assets", "evals"] as const;
const SKIP_NAMES = new Set([".DS_Store", "__MACOSX", "node_modules", ".git"]);

interface FileToInsert {
  path: string;
  content: Buffer;
  size: number;
  contentType: string | null;
}

interface CliArgs {
  dryRun: boolean;
  ownerOverride: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false, ownerOverride: null };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--owner=")) out.ownerOverride = a.slice(8);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args: CliArgs = parseArgs(process.argv);
  const root: string = path.resolve(
    process.env.NANGO_SKILLS_HOME ?? path.join(process.cwd(), "skills"),
  );
  console.log(`[migrate-skills] scanning ${root} (dry-run=${args.dryRun})`);

  const dirs: string[] = await listSkillDirs(root);
  if (dirs.length === 0) {
    console.log("[migrate-skills] no skill directories found; nothing to do");
    process.exit(0);
  }

  const ownerId: string | null = await resolveOwnerId(args.ownerOverride);
  if (!ownerId) {
    console.error(
      "[migrate-skills] no owner available (no admin user, no --owner=<uuid>); aborting",
    );
    process.exit(2);
  }

  const stats = { inserted: 0, replaced: 0, skipped: 0, errors: 0 };
  for (const dirName of dirs) {
    const dirAbs: string = path.join(root, dirName);
    try {
      const r = await migrateOne(dirAbs, dirName, ownerId, args.dryRun);
      if (r === "inserted") stats.inserted += 1;
      else if (r === "replaced") stats.replaced += 1;
      else if (r === "skipped-builtin") stats.skipped += 1;
    } catch (err) {
      stats.errors += 1;
      const msg: string = err instanceof Error ? err.message : String(err);
      console.error(`[migrate-skills] ${dirName}: ${msg}`);
    }
  }

  console.log(
    `[migrate-skills] done — inserted=${stats.inserted} replaced=${stats.replaced} skipped=${stats.skipped} errors=${stats.errors}`,
  );
  if (stats.errors > 0) process.exit(1);
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
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !SKIP_NAMES.has(e.name) &&
        !e.name.startsWith("."),
    )
    .map((e) => e.name)
    .sort();
}

async function resolveOwnerId(override: string | null): Promise<string | null> {
  if (override) return override;
  const rows = await db
    .select({ id: UserTable.id })
    .from(UserTable)
    .where(eq(UserTable.role, "admin"))
    .orderBy(asc(UserTable.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

type Outcome = "inserted" | "replaced" | "skipped-builtin";

async function migrateOne(
  dirAbs: string,
  dirName: string,
  ownerId: string,
  dryRun: boolean,
): Promise<Outcome> {
  const skillMdPath: string = path.join(dirAbs, "SKILL.md");
  let skillMd: string;
  try {
    skillMd = await fs.readFile(skillMdPath, "utf8");
  } catch (err) {
    const code: string | undefined = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`no SKILL.md at ${skillMdPath}`);
    }
    throw err;
  }

  let parsed: ReturnType<typeof parseSkillMd>;
  try {
    parsed = parseSkillMd(skillMd);
  } catch (err) {
    if (err instanceof SkillParseError) throw new Error(`parse: ${err.message}`);
    throw err;
  }

  const existing = await findExistingRow(parsed.frontmatter.name, ownerId);

  if (existing && existing.source === "builtin") {
    console.log(`[migrate-skills] ${dirName}: row is builtin — skipped`);
    return "skipped-builtin";
  }

  const files: FileToInsert[] = await collectFiles(dirAbs);
  enforceTotals(dirName, files);

  if (dryRun) {
    const verb: string = existing ? "would replace" : "would insert";
    console.log(
      `[migrate-skills] ${dirName}: ${verb} (${files.length} file(s))`,
    );
    return existing ? "replaced" : "inserted";
  }

  let outcome: Outcome;
  await db.transaction(async (tx) => {
    const skillId: string = existing
      ? existing.id
      : await insertLocalRow(tx, { parsed, skillMd, ownerId });

    await tx.delete(SkillFileTable).where(eq(SkillFileTable.skillId, skillId));
    if (files.length > 0) {
      await tx.insert(SkillFileTable).values(
        files.map((f) => ({
          skillId,
          path: f.path,
          content: f.content,
          size: f.size,
          contentType: f.contentType,
        })),
      );
    }
    outcome = existing ? "replaced" : "inserted";
  });
  console.log(
    `[migrate-skills] ${dirName}: ${outcome!} (${files.length} file(s))`,
  );
  return outcome!;
}

async function findExistingRow(
  name: string,
  ownerId: string,
): Promise<{ id: string; source: string } | null> {
  const rows = await db
    .select({ id: SkillTable.id, source: SkillTable.source })
    .from(SkillTable)
    .where(
      and(
        eq(SkillTable.name, name),
        eq(SkillTable.source, "local"),
        eq(SkillTable.createdBy, ownerId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertLocalRow(
  tx: Tx,
  args: {
    parsed: ReturnType<typeof parseSkillMd>;
    skillMd: string;
    ownerId: string;
  },
): Promise<string> {
  const [row] = await tx
    .insert(SkillTable)
    .values({
      name: args.parsed.frontmatter.name,
      description: args.parsed.frontmatter.description,
      version: args.parsed.frontmatter.version,
      skillMd: args.skillMd,
      source: "local",
      enabled: true,
      visibility: "private",
      createdBy: args.ownerId,
    })
    .returning({ id: SkillTable.id });
  return row.id;
}

async function collectFiles(skillAbs: string): Promise<FileToInsert[]> {
  const out: FileToInsert[] = [];
  for (const sub of ALLOWED_SUBDIRS) {
    const subAbs: string = path.join(skillAbs, sub);
    let exists: boolean = true;
    try {
      const st = await fs.stat(subAbs);
      if (!st.isDirectory()) exists = false;
    } catch (err) {
      const code: string | undefined = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") exists = false;
      else throw err;
    }
    if (!exists) continue;
    await walkInto(subAbs, sub, out);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function walkInto(
  dirAbs: string,
  relPrefix: string,
  out: FileToInsert[],
): Promise<void> {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    const childAbs: string = path.join(dirAbs, e.name);
    const childRel: string = `${relPrefix}/${e.name}`;
    if (e.isDirectory()) {
      await walkInto(childAbs, childRel, out);
      continue;
    }
    if (!e.isFile()) continue;

    try {
      validateSkillFilePath(childRel);
    } catch (err) {
      if (err instanceof InvalidSkillPathError) {
        throw new Error(`invalid path "${childRel}": ${err.message}`);
      }
      throw err;
    }

    const buf: Buffer = await fs.readFile(childAbs);
    if (buf.byteLength > MAX_FILE_BYTES()) {
      throw new Error(
        `${childRel} exceeds per-file cap (${buf.byteLength} > ${MAX_FILE_BYTES()} bytes)`,
      );
    }
    out.push({
      path: childRel,
      content: buf,
      size: buf.byteLength,
      contentType: guessContentType(childRel, isLikelyText(buf)),
    });
  }
}

function enforceTotals(dirName: string, files: FileToInsert[]): void {
  if (files.length > MAX_FILES_PER_SKILL()) {
    throw new Error(
      `${dirName} has too many files (${files.length} > ${MAX_FILES_PER_SKILL()})`,
    );
  }
  const total: number = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES_PER_SKILL()) {
    throw new Error(
      `${dirName} too large (${total} > ${MAX_TOTAL_BYTES_PER_SKILL()} bytes)`,
    );
  }
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
  return EXT_TO_MIME[ext] ?? (isText ? "text/plain" : null);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
