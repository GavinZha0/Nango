import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { EvalCaseTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadSuite } from "@/lib/evaluation/access";
import * as storage from "@/lib/evaluation/storage";

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
    criteria: z.record(z.string(), z.unknown()).optional(),
    dimensionOverride: z.array(z.string()).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, createSchema);
    const suite = await loadSuite(params.id, session);

    if (suite.createdBy !== session.user.id && session.user.role !== "admin") {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot add cases to this eval suite.",
      );
    }

    try {
      const [row] = await db
        .insert(EvalCaseTable)
        .values({
          suiteId: suite.id,
          name: body.name,
          turns: (body.turns ?? []) as unknown,
          criteria: (body.criteria ?? {}) as unknown,
          dimensionOverride: body.dimensionOverride ?? null,
          enabled: body.enabled ?? true,
        })
        .returning();
      return NextResponse.json(row, { status: 201 });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code === "23505") {
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
