/**
 * Boot-time reconcile of `dist/builtin-skills.json` into the DB.
 */

import "server-only";

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SkillTable, SkillFileTable } from "@/lib/db/schema";

import { invalidateForSkillChange } from "./invalidation";

interface BundleFile {
  path: string;
  size: number;
  contentType: string | null;
  encoding: "utf8" | "base64";
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

interface SkillsBundle {
  $schema: "nango/builtin-skills@1";
  generatedAt: string;
  skills: BundleSkill[];
}

const DEFAULT_BUNDLE_PATH: string = path.join(
  process.cwd(),
  "dist",
  "builtin-skills.json",
);

export interface SeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
  disabled: number;
}

/**
 * Read bundle from disk, diff against `skill` rows where source='builtin',
 * and apply inserts / updates / soft-disables in a single transaction.
 *
 * Returns counts; never throws into the caller's success path on a
 * missing bundle (logs a warning so first-run dev experience is gentle).
 */
export async function seedBuiltinSkills(
  bundlePath: string = DEFAULT_BUNDLE_PATH,
): Promise<SeedResult> {
  const bundle: SkillsBundle | null = await readBundle(bundlePath);
  if (!bundle) {
    return { inserted: 0, updated: 0, unchanged: 0, disabled: 0 };
  }

  const inDbRows: Array<typeof SkillTable.$inferSelect> = await db
    .select()
    .from(SkillTable)
    .where(eq(SkillTable.source, "builtin"));
  const inDbByName: Map<string, (typeof inDbRows)[number]> = new Map(
    inDbRows.map((r) => [r.name, r]),
  );
  const inBundle: Set<string> = new Set(bundle.skills.map((s) => s.name));

  const result: SeedResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    disabled: 0,
  };
  const touchedIds: string[] = [];

  await db.transaction(async (tx) => {
    for (const s of bundle.skills) {
      const row = inDbByName.get(s.name);
      if (row && row.checksum === s.checksum && row.enabled) {
        result.unchanged += 1;
        continue;
      }
      if (row) {
        await updateBuiltinRow(tx, row.id, s);
        touchedIds.push(row.id);
        result.updated += 1;
      } else {
        const id: string = await insertBuiltinRow(tx, s);
        touchedIds.push(id);
        result.inserted += 1;
      }
    }
    for (const row of inDbRows) {
      if (inBundle.has(row.name)) continue;
      if (!row.enabled) continue;
      await tx
        .update(SkillTable)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(SkillTable.id, row.id));
      touchedIds.push(row.id);
      result.disabled += 1;
    }
  });

  for (const id of touchedIds) {
    try {
      await invalidateForSkillChange(id);
    } catch (err) {
      console.warn("[skills] cache invalidation after reconcile failed:", err);
    }
  }

  if (
    result.inserted +
      result.updated +
      result.disabled +
      result.unchanged >
    0
  ) {
    console.log(
      `[skills] builtin reconcile: +${result.inserted} ~${result.updated} =${result.unchanged} -${result.disabled}`,
    );
  }
  return result;
}

async function readBundle(p: string): Promise<SkillsBundle | null> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    const code: string | undefined = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.warn(
        `[skills] builtin bundle not found at ${p}; skipping reconcile. Run \`pnpm build:skills\`.`,
      );
      return null;
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isBundle(parsed)) {
    throw new Error(`[skills] invalid builtin bundle shape at ${p}`);
  }
  return parsed;
}

function isBundle(x: unknown): x is SkillsBundle {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.$schema === "nango/builtin-skills@1" && Array.isArray(o.skills);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertBuiltinRow(tx: Tx, s: BundleSkill): Promise<string> {
  const [row] = await tx
    .insert(SkillTable)
    .values({
      name: s.name,
      description: s.description,
      version: s.version,
      skillMd: s.skillMd,
      checksum: s.checksum,
      source: "builtin",
      enabled: true,
      visibility: "public",
    })
    .returning({ id: SkillTable.id });
  await replaceFiles(tx, row.id, s.files);
  return row.id;
}

async function updateBuiltinRow(
  tx: Tx,
  skillId: string,
  s: BundleSkill,
): Promise<void> {
  await tx
    .update(SkillTable)
    .set({
      description: s.description,
      version: s.version,
      skillMd: s.skillMd,
      checksum: s.checksum,
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(SkillTable.id, skillId));
  await replaceFiles(tx, skillId, s.files);
}

async function replaceFiles(
  tx: Tx,
  skillId: string,
  files: BundleFile[],
): Promise<void> {
  await tx.delete(SkillFileTable).where(eq(SkillFileTable.skillId, skillId));
  if (files.length === 0) return;
  const rows = files.map((f) => ({
    skillId,
    path: f.path,
    content: decode(f),
    size: f.size,
    contentType: f.contentType,
  }));
  await tx.insert(SkillFileTable).values(rows);
}

function decode(f: BundleFile): Buffer {
  return f.encoding === "utf8"
    ? Buffer.from(f.content, "utf8")
    : Buffer.from(f.content, "base64");
}

