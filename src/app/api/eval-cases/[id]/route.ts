import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { EvalCaseTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadCase } from "@/lib/evaluation/access";

const ROUTE = "/api/eval-cases/[id]";

const caseIdSchema = z.coerce.number().int().positive();

// PATCH /api/eval-cases/[id]

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    turns: z.array(z.object({ userMessage: z.string() }).passthrough()).optional(),
    criteria: z.record(z.string(), z.unknown()).optional(),
    dimensionOverride: z.array(z.string()).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const parsed = caseIdSchema.safeParse(params.id);
    if (!parsed.success) {
      throw new ApiError("NOT_FOUND", 404, "Eval case not found.");
    }
    const body = await parseBody(req, updateSchema);
    const { caseRow, suite } = await loadCase(parsed.data, session);

    if (suite.createdBy !== session.user.id && session.user.role !== "admin") {
      throw new ApiError("FORBIDDEN", 403, "You cannot edit this eval case.");
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.turns !== undefined) updates.turns = body.turns as unknown;
    if (body.criteria !== undefined) updates.criteria = body.criteria as unknown;
    if (body.dimensionOverride !== undefined)
      updates.dimensionOverride = body.dimensionOverride;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    updates.updatedAt = sql`CURRENT_TIMESTAMP`;

    try {
      const [row] = await db
        .update(EvalCaseTable)
        .set(updates)
        .where(eq(EvalCaseTable.id, caseRow.id))
        .returning();
      return NextResponse.json(row);
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code === "23505" && body.name) {
        throw new ApiError(
          "CONFLICT",
          409,
          `A case named "${body.name}" already exists in this suite.`,
        );
      }
      throw err;
    }
  },
);

// DELETE /api/eval-cases/[id]

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const parsed = caseIdSchema.safeParse(params.id);
    if (!parsed.success) {
      throw new ApiError("NOT_FOUND", 404, "Eval case not found.");
    }
    const { caseRow, suite } = await loadCase(parsed.data, session);

    if (suite.createdBy !== session.user.id && session.user.role !== "admin") {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this eval case.",
      );
    }

    await db
      .delete(EvalCaseTable)
      .where(eq(EvalCaseTable.id, caseRow.id));
    return new NextResponse(null, { status: 204 });
  },
);
