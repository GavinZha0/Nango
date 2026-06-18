import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { EvalCaseTable, EvalSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadSuite } from "@/lib/evaluation/access";

const ROUTE = "/api/eval-suites/[id]";

// GET /api/eval-suites/[id]

export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadSuite(params.id, session);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(EvalCaseTable)
      .where(eq(EvalCaseTable.suiteId, suite.id));
    return NextResponse.json({ ...suite, caseCount: count });
  },
);

// PATCH /api/eval-suites/[id]

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    evaluatorAgentId: z.string().uuid().optional().nullable(),
    dimensionIds: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const suite = await loadSuite(params.id, session);

    if (suite.createdBy !== session.user.id && session.user.role !== "admin") {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this eval suite.");
    }

    const updates: Record<string, unknown> = { updatedBy: session.user.id };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.evaluatorAgentId !== undefined)
      updates.evaluatorAgentId = body.evaluatorAgentId;
    if (body.dimensionIds !== undefined) updates.dimensionIds = body.dimensionIds;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    updates.updatedAt = sql`CURRENT_TIMESTAMP`;

    try {
      const [updated] = await db
        .update(EvalSuiteTable)
        .set(updates)
        .where(eq(EvalSuiteTable.id, suite.id))
        .returning();
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(EvalCaseTable)
        .where(eq(EvalCaseTable.suiteId, suite.id));
      return NextResponse.json({ ...updated, caseCount: count });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code === "23505" && body.name) {
        throw new ApiError(
          "CONFLICT",
          409,
          `An eval suite named "${body.name}" already exists for this agent.`,
        );
      }
      throw err;
    }
  },
);

// DELETE /api/eval-suites/[id]

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadSuite(params.id, session);
    if (suite.createdBy !== session.user.id && session.user.role !== "admin") {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this eval suite.",
      );
    }
    await db
      .delete(EvalSuiteTable)
      .where(eq(EvalSuiteTable.id, suite.id));
    return new NextResponse(null, { status: 204 });
  },
);
