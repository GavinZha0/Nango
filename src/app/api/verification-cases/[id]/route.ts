import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { VerificationCaseTable, VerificationSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { loadVisibleCase } from "@/lib/verification/access";
import {
  assertionsArraySchema,
  caseInputSchema,
} from "@/lib/verification/wire-schemas";

const ROUTE = "/api/verification-cases/[id]";

// PATCH /api/verification-cases/[id]
// Update name / input / assertions / enabled. The case's target
// (mcpServerId / toolName / workflowId) is immutable in V1 — changing
// it would invalidate any history that already references the case.

const idSchema = z.coerce.number().int().positive();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    input: caseInputSchema.optional(),
    assertions: assertionsArraySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const idParse = idSchema.safeParse(params.id);
    if (!idParse.success) {
      throw new ApiError("NOT_FOUND", 404, "Verification case not found.");
    }
    const caseId = idParse.data;
    const body = await parseBody(req, patchSchema);

    const { caseRow, suite } = await loadVisibleCase(caseId, session);
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
        "You cannot edit cases in this verification suite.",
      );
    }

    const updates: Record<string, unknown> = {
      updatedAt: sql`CURRENT_TIMESTAMP`,
    };
    if (body.name !== undefined) updates.name = body.name;
    if (body.input !== undefined) updates.input = body.input;
    if (body.assertions !== undefined) {
      updates.assertions = body.assertions as unknown;
    }
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    try {
      const [row] = await db
        .update(VerificationCaseTable)
        .set(updates)
        .where(eq(VerificationCaseTable.id, caseRow.id))
        .returning();
      
      // Join with suite to get mcpServerId for the response
      const [suiteRow] = await db
        .select()
        .from(VerificationSuiteTable)
        .where(eq(VerificationSuiteTable.id, row.suiteId))
        .limit(1);
      
      const responseRow = {
        ...row,
        mcpServerId: suiteRow?.mcpServerId ?? null,
        toolName: suiteRow?.toolName ?? null,
      };
      
      return NextResponse.json(responseRow);
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

// DELETE /api/verification-cases/[id]
// Cascade: verification_case_result rows drop via FK ON DELETE CASCADE.

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const idParse = idSchema.safeParse(params.id);
    if (!idParse.success) {
      throw new ApiError("NOT_FOUND", 404, "Verification case not found.");
    }
    const caseId = idParse.data;
    const { caseRow, suite } = await loadVisibleCase(caseId, session);
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
        "You cannot delete cases in this verification suite.",
      );
    }
    await db
      .delete(VerificationCaseTable)
      .where(eq(VerificationCaseTable.id, caseRow.id));
    return new NextResponse(null, { status: 204 });
  },
);
