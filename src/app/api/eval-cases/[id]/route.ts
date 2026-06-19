import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { loadCase } from "@/lib/evaluation/access";
import * as storage from "@/lib/evaluation/storage";
import { evalCriteriaSchema } from "@/lib/evaluation/types";

const ROUTE = "/api/eval-cases/[id]";

const caseIdSchema = z.coerce.number().int().positive();

// PATCH /api/eval-cases/[id]

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    turns: z.array(z.object({ userMessage: z.string() }).passthrough()).optional(),
    criteria: evalCriteriaSchema.optional(),
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

    try {
      const row = await storage.updateCase(caseRow.id, body);
      return NextResponse.json(row);
    } catch (err) {
      if (isUniqueViolation(err) && body.name) {
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

    await storage.deleteCase(caseRow.id);
    return new NextResponse(null, { status: 204 });
  },
);
