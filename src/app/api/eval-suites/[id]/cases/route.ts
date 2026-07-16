import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { loadSuite } from "@/lib/evaluation/access";
import * as storage from "@/lib/evaluation/storage";
import { evalCriteriaSchema } from "@/lib/evaluation/types";

const ROUTE = "/api/eval-suites/[id]/cases";

// GET /api/eval-suites/[id]/cases

export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadSuite(params.id, session);
    const cases = await storage.listCasesBySuite(suite.id);
    return NextResponse.json(cases);
  },
);

// POST /api/eval-suites/[id]/cases

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    turns: z.array(z.object({ userMessage: z.string() }).passthrough()).optional(),
    criteria: evalCriteriaSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, createSchema);
    const suite = await loadSuite(params.id, session);

    const rbac = {
      visibility: suite.visibility as "private" | "public",
      createdBy: suite.createdBy,
    };
    if (!canEditResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot add cases to this eval suite.",
      );
    }

    try {
      const row = await storage.createCase({
        suiteId: suite.id,
        createdBy: session.user.id,
        ...body,
      });
      return NextResponse.json(row, { status: 201 });
    } catch (err) {
      if (isUniqueViolation(err)) {
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
