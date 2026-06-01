import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { visibilitySql } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { VerificationSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { and, asc, eq, sql } from "drizzle-orm";

const ROUTE = "/api/verification-suites";

// GET /api/verification-suites?category=mcp|workflow
// Returns visible suites in the requested category (alphabetical).

export const GET = withEditor(ROUTE, async ({ req, session }) => {
  const category = new URL(req.url).searchParams.get("category");
  if (category !== "mcp" && category !== "workflow") {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "Query param `category` must be 'mcp' or 'workflow'.",
    );
  }

  // Projection mirrors `select()` but pulls a correlated COUNT for the
  // case rows of each suite, so the left-panel can render a badge
  // without an N+1 fetch. Same pattern used in builtin-agents/route.ts.
  const rows = await db
    .select({
      id: VerificationSuiteTable.id,
      name: VerificationSuiteTable.name,
      description: VerificationSuiteTable.description,
      category: VerificationSuiteTable.category,
      visibility: VerificationSuiteTable.visibility,
      enabled: VerificationSuiteTable.enabled,
      timeoutSec: VerificationSuiteTable.timeoutSec,
      createdBy: VerificationSuiteTable.createdBy,
      updatedBy: VerificationSuiteTable.updatedBy,
      createdAt: VerificationSuiteTable.createdAt,
      updatedAt: VerificationSuiteTable.updatedAt,
      // NB: column refs must be fully qualified with the table name —
      // inside the correlated subquery, an unqualified `"id"` resolves
      // to `verification_case.id` (bigint), not the outer suite's `id`
      // (uuid). drizzle does not auto-qualify here, so we spell the
      // names out, same pattern as builtin-agents/route.ts.
      caseCount: sql<number>`(
        select count(*)::int from "verification_case"
        where "verification_case"."suite_id" = "verification_suite"."id"
      )`,
    })
    .from(VerificationSuiteTable)
    .where(
      and(
        eq(VerificationSuiteTable.category, category),
        visibilitySql(
          session,
          VerificationSuiteTable.visibility,
          VerificationSuiteTable.createdBy,
        ),
      ),
    )
    .orderBy(asc(VerificationSuiteTable.name));

  return NextResponse.json(rows);
});

// POST /api/verification-suites
// Create a new suite. Editor+ only.

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    category: z.enum(["mcp", "workflow"]),
    visibility: z.enum(["private", "public"]).optional(),
    timeoutSec: z.number().int().min(10).max(7200).optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  // Global name uniqueness is enforced by the DB UNIQUE constraint
  // — surface as 409 if it trips so the UI can show a nice message.
  try {
    const [row] = await db
      .insert(VerificationSuiteTable)
      .values({
        name: body.name,
        description: body.description ?? null,
        category: body.category,
        visibility: body.visibility ?? "private",
        timeoutSec: body.timeoutSec ?? 300,
        createdBy: session.user.id,
        updatedBy: session.user.id,
      })
      .returning();
    // Newly-created suite has no cases yet; surface the same shape as
    // the list endpoint so the client store can upsert without losing
    // the `caseCount` field on the row.
    return NextResponse.json({ ...row, caseCount: 0 }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        "CONFLICT",
        409,
        `A verification suite named "${body.name}" already exists.`,
      );
    }
    throw err;
  }
});

function isUniqueViolation(err: unknown): boolean {
  // drizzle wraps the pg error in `cause`
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code === "23505";
}
