import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadVisibleSuite } from "@/lib/verification/access";
import * as storage from "@/lib/verification/storage";
import {
  assertionsArraySchema,
  caseInputSchema,
} from "@/lib/verification/wire-schemas";
import { db } from "@/lib/db";
import { VerificationCaseTable } from "@/lib/db/schema";

const ROUTE = "/api/verification-suites/[id]/cases";

// GET /api/verification-suites/[id]/cases
// All cases in the suite, alphabetical.

export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadVisibleSuite(params.id, session);
    const cases = await storage.listCasesBySuite(suite.id);
    return NextResponse.json(cases);
  },
);

// POST /api/verification-suites/[id]/cases
// Create a case. Target shape XOR is enforced both here and by the DB
// CHECK constraint — we pre-validate so the user sees a 400 with a
// friendly message instead of a 500 from a constraint trip.

const mcpCaseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    mcpServerId: z.string().uuid(),
    toolName: z.string().min(1).max(200),
    input: caseInputSchema.optional(),
    assertions: assertionsArraySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const workflowCaseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    workflowId: z.string().uuid(),
    input: caseInputSchema.optional(),
    assertions: assertionsArraySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const createSchema = z.union([mcpCaseSchema, workflowCaseSchema]);

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, createSchema);
    const suite = await loadVisibleSuite(params.id, session);

    if (
      !canEditResource(
        {
          visibility: suite.visibility as "private" | "public",
          createdBy: suite.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot add cases to this verification suite.",
      );
    }

    // Category gate: workflow cases are V2-only. Refuse early with a
    // structured code so the UI can surface "Coming soon".
    const isMcpCase = "mcpServerId" in body;
    if (suite.category === "workflow") {
      throw new ApiError(
        "NOT_IMPLEMENTED",
        501,
        "Workflow verification cases are coming in a later release.",
        { code: "WORKFLOW_TESTS_V2" },
      );
    }
    if (suite.category === "mcp" && !isMcpCase) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        "MCP suite requires (mcpServerId, toolName) on the case.",
      );
    }

    try {
      const [row] = await db
        .insert(VerificationCaseTable)
        .values({
          suiteId: suite.id,
          name: body.name,
          mcpServerId: isMcpCase ? body.mcpServerId : null,
          toolName: isMcpCase ? body.toolName : null,
          workflowId: isMcpCase ? null : body.workflowId,
          input: body.input ?? {},
          assertions: (body.assertions ?? []) as unknown,
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
