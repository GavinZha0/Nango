/**
 * Postgres-backed `SkillStorage` implementation.
 *
 * @see docs/skills.md
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SkillTable, SkillFileTable } from "@/lib/db/schema";
import { visibilitySql } from "@/lib/auth/permissions";
import { parseSkillMd } from "@/lib/skills/parser";

import {
  InvalidSkillPathError,
  MAX_FILES_PER_SKILL,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES_PER_SKILL,
  validateSkillFilePath,
  type CreateCustomSkillInput,
  type PutSkillFileInput,
  type SkillFileMeta,
  type SkillFileRecord,
  type SkillRecord,
  type SkillSource,
  type SkillStorage,
  type SkillVisibility,
  type UpdateSkillContentInput,
  type UpdateSkillFlagsInput,
} from "./skill-storage";

// Mappers

type SkillRow = typeof SkillTable.$inferSelect;
type SkillFileRow = typeof SkillFileTable.$inferSelect;

function toRecord(row: SkillRow): SkillRecord {
  return {
    skillId: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    skillMd: row.skillMd,
    source: row.source as SkillSource,
    enabled: row.enabled,
    visibility: row.visibility as SkillVisibility,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

function toFileRecord(row: SkillFileRow): SkillFileRecord {
  return {
    skillId: row.skillId,
    path: row.path,
    content: row.content,
    size: row.size,
    contentType: row.contentType,
  };
}

// Implementation

export class DbSkillStorage implements SkillStorage {
  // Read

  async loadSkill(skillId: string): Promise<SkillRecord | null> {
    const [row] = await db
      .select()
      .from(SkillTable)
      .where(eq(SkillTable.id, skillId))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async listVisible(session: Parameters<SkillStorage["listVisible"]>[0]): Promise<SkillRecord[]> {
    const rows = await db
      .select()
      .from(SkillTable)
      .where(visibilitySql(session, SkillTable.visibility, SkillTable.createdBy));
    return rows.map(toRecord);
  }

  async readFile(skillId: string, path: string): Promise<SkillFileRecord | null> {
    try {
      validateSkillFilePath(path);
    } catch (err) {
      if (err instanceof InvalidSkillPathError) return null;
      throw err;
    }
    const [row] = await db
      .select()
      .from(SkillFileTable)
      .where(
        and(eq(SkillFileTable.skillId, skillId), eq(SkillFileTable.path, path)),
      )
      .limit(1);
    return row ? toFileRecord(row) : null;
  }

  async listFiles(skillId: string): Promise<SkillFileMeta[]> {
    const rows = await db
      .select({
        path: SkillFileTable.path,
        size: SkillFileTable.size,
        contentType: SkillFileTable.contentType,
      })
      .from(SkillFileTable)
      .where(eq(SkillFileTable.skillId, skillId));
    return rows;
  }

  // Write

  async createCustom(input: CreateCustomSkillInput): Promise<{ id: string }> {
    const parsed = parseSkillMd(input.skillMd);
    const [row] = await db
      .insert(SkillTable)
      .values({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        version: parsed.frontmatter.version,
        skillMd: input.skillMd,
        source: "local",
        enabled: true,
        visibility: input.visibility ?? "private",
        createdBy: input.createdBy,
      })
      .returning({ id: SkillTable.id });
    return { id: row.id };
  }

  async updateContent(input: UpdateSkillContentInput): Promise<void> {
    const parsed = parseSkillMd(input.skillMd);
    await db
      .update(SkillTable)
      .set({
        // Note: `name` is not allowed to change via PATCH (caller enforces).
        description: parsed.frontmatter.description,
        version: parsed.frontmatter.version,
        skillMd: input.skillMd,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      })
      .where(eq(SkillTable.id, input.skillId));
  }

  async updateFlags(input: UpdateSkillFlagsInput): Promise<void> {
    const updates: Partial<typeof SkillTable.$inferInsert> = {
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.visibility !== undefined) updates.visibility = input.visibility;
    await db.update(SkillTable).set(updates).where(eq(SkillTable.id, input.skillId));
  }

  async delete(skillId: string): Promise<void> {
    await db.delete(SkillTable).where(eq(SkillTable.id, skillId));
    // skill_file rows cascade via the FK ON DELETE CASCADE.
  }

  async putFile(input: PutSkillFileInput): Promise<void> {
    validateSkillFilePath(input.path);
    if (input.content.length > MAX_FILE_BYTES()) {
      throw new InvalidSkillPathError(
        `File exceeds ${Math.round(MAX_FILE_BYTES() / 1024)} KB cap.`,
      );
    }

    // Per-skill caps: enforce file count + total size with a single query.
    const existing = await db
      .select({ path: SkillFileTable.path, size: SkillFileTable.size })
      .from(SkillFileTable)
      .where(eq(SkillFileTable.skillId, input.skillId));
    const existingFor = existing.find((f) => f.path === input.path);
    const projectedCount = existing.length + (existingFor ? 0 : 1);
    const projectedTotal =
      existing.reduce((acc, f) => acc + f.size, 0)
      - (existingFor?.size ?? 0)
      + input.content.length;
    if (projectedCount > MAX_FILES_PER_SKILL()) {
      throw new InvalidSkillPathError(
        `Skill exceeds ${MAX_FILES_PER_SKILL()} files cap.`,
      );
    }
    if (projectedTotal > MAX_TOTAL_BYTES_PER_SKILL()) {
      throw new InvalidSkillPathError(
        `Skill total size exceeds ${Math.round(MAX_TOTAL_BYTES_PER_SKILL() / 1024 / 1024)} MB cap.`,
      );
    }

    // Upsert by (skillId, path).
    await db
      .insert(SkillFileTable)
      .values({
        skillId: input.skillId,
        path: input.path,
        content: input.content,
        size: input.content.length,
        contentType: input.contentType ?? null,
      })
      .onConflictDoUpdate({
        target: [SkillFileTable.skillId, SkillFileTable.path],
        set: {
          content: input.content,
          size: input.content.length,
          contentType: input.contentType ?? null,
          updatedAt: new Date(),
        },
      });
  }

  async deleteFile(skillId: string, path: string): Promise<void> {
    validateSkillFilePath(path);
    await db
      .delete(SkillFileTable)
      .where(
        and(eq(SkillFileTable.skillId, skillId), eq(SkillFileTable.path, path)),
      );
  }
}

// Singleton

let instance: DbSkillStorage | null = null;

/** Process-wide singleton; lifetime matches the Node process. */
export function getDbSkillStorage(): DbSkillStorage {
  if (!instance) instance = new DbSkillStorage();
  return instance;
}
