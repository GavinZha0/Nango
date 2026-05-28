import "server-only";

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import { parseBody } from "@/lib/http/validation";
import { invalidateForSkillChange } from "@/lib/cache/invalidation";
import { parseSkillMd, SkillParseError } from "@/lib/skills/parser";
import { getDbSkillStorage } from "@/lib/skills/storage";

const ROUTE = "/api/skills";

// GET /api/skills
// Returns skills visible to the current user — own + public.

export const GET = withSession(ROUTE, async ({ session }) => {
  const skills = await db
    .select({
      id: SkillTable.id,
      name: SkillTable.name,
      description: SkillTable.description,
      version: SkillTable.version,
      source: SkillTable.source,
      enabled: SkillTable.enabled,
      visibility: SkillTable.visibility,
      createdBy: SkillTable.createdBy,
      updatedBy: SkillTable.updatedBy,
      createdAt: SkillTable.createdAt,
      updatedAt: SkillTable.updatedAt,
    })
    .from(SkillTable)
    .where(visibilitySql(session, SkillTable.visibility, SkillTable.createdBy))
    .orderBy(desc(SkillTable.createdAt));

  return NextResponse.json(skills);
});

// POST /api/skills
// Create a new local skill. Pure DB write via the storage layer; no
// filesystem touched.

const createSchema = z
  .object({
    /** Verbatim SKILL.md including frontmatter. Name + description parsed from it. */
    skillMd: z.string().min(1, "must not be empty"),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  // Parse early so a malformed frontmatter never becomes a half-written row.
  let parsed;
  try {
    parsed = parseSkillMd(body.skillMd);
  } catch (err) {
    if (err instanceof SkillParseError) {
      throw new ApiError("VALIDATION_FAILED", 400, err.message);
    }
    throw err;
  }

  // Per-creator name uniqueness (local skills): keep names predictable
  // for the same author. Cross-user duplicates are allowed.
  const existing = await db
    .select({ id: SkillTable.id })
    .from(SkillTable)
    .where(
      and(
        eq(SkillTable.source, "local"),
        eq(SkillTable.name, parsed.frontmatter.name),
        eq(SkillTable.createdBy, session.user.id),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new ApiError(
      "CONFLICT",
      409,
      `You already own a skill named "${parsed.frontmatter.name}".`,
    );
  }

  const storage = getDbSkillStorage();
  const { id } = await storage.createCustom({
    skillMd: body.skillMd,
    visibility: body.visibility,
    createdBy: session.user.id,
  });

  await invalidateForSkillChange(id);

  const [row] = await db
    .select()
    .from(SkillTable)
    .where(eq(SkillTable.id, id))
    .limit(1);

  return NextResponse.json(row, { status: 201 });
});
