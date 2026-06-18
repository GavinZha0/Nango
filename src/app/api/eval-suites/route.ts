import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { EvalSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { asc, sql } from "drizzle-orm";

const ROUTE = "/api/eval-suites";

// GET /api/eval-suites?agentId=<id>&agentSource=builtin
// Returns suites for a specific agent with case counts.

export const GET = withEditor(ROUTE, async ({ req, session }) => {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  if (!agentId) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "Query param `agentId` is required.",
    );
  }
  const agentSource = url.searchParams.get("agentSource") ?? "builtin";

  const rows = await db
    .select({
      id: EvalSuiteTable.id,
      agentId: EvalSuiteTable.agentId,
      agentSource: EvalSuiteTable.agentSource,
      credentialId: EvalSuiteTable.credentialId,
      evaluatorAgentId: EvalSuiteTable.evaluatorAgentId,
      name: EvalSuiteTable.name,
      description: EvalSuiteTable.description,
      dimensionIds: EvalSuiteTable.dimensionIds,
      enabled: EvalSuiteTable.enabled,
      createdBy: EvalSuiteTable.createdBy,
      updatedBy: EvalSuiteTable.updatedBy,
      createdAt: EvalSuiteTable.createdAt,
      updatedAt: EvalSuiteTable.updatedAt,
      caseCount: sql<number>`(
        select count(*)::int from "eval_case"
        where "eval_case"."suite_id" = "eval_suite"."id"
      )`,
    })
    .from(EvalSuiteTable)
    .where(
      sql`${EvalSuiteTable.agentId} = ${agentId}
        AND ${EvalSuiteTable.agentSource} = ${agentSource}
        AND ${EvalSuiteTable.createdBy} = ${session.user.id}`,
    )
    .orderBy(asc(EvalSuiteTable.name));

  return NextResponse.json(rows);
});

// POST /api/eval-suites

const createSchema = z
  .object({
    agentId: z.string().min(1),
    agentSource: z.enum(["builtin", "backend"]).optional(),
    credentialId: z.string().uuid().optional().nullable(),
    evaluatorAgentId: z.string().uuid().optional().nullable(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    dimensionIds: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  try {
    const [row] = await db
      .insert(EvalSuiteTable)
      .values({
        agentId: body.agentId,
        agentSource: body.agentSource ?? "builtin",
        credentialId: body.credentialId ?? null,
        evaluatorAgentId: body.evaluatorAgentId ?? null,
        name: body.name,
        description: body.description ?? null,
        dimensionIds: body.dimensionIds ?? [],
        enabled: body.enabled ?? true,
        createdBy: session.user.id,
        updatedBy: session.user.id,
      })
      .returning();
    return NextResponse.json({ ...row, caseCount: 0 }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        "CONFLICT",
        409,
        `An eval suite named "${body.name}" already exists for this agent.`,
      );
    }
    throw err;
  }
});

function isUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code === "23505";
}
