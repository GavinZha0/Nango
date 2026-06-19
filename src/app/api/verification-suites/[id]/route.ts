import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
} from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import {
  VerificationCaseTable,
  VerificationSuiteTable,
} from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody, isUniqueViolation } from "@/lib/http/validation";
import { loadVisibleSuite } from "@/lib/verification/access";

const ROUTE = "/api/verification-suites/[id]";

// GET /api/verification-suites/[id]
// Suite metadata + case count. The full case list is fetched
// separately via `/cases` so this endpoint stays cheap.

export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadVisibleSuite(params.id, session);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(VerificationCaseTable)
      .where(eq(VerificationCaseTable.suiteId, suite.id));
    return NextResponse.json({ ...suite, caseCount: count });
  },
);

// PATCH /api/verification-suites/[id]
// Editor+ — update metadata. Renames respect global uniqueness.

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    timeoutSec: z.number().int().min(10).max(7200).optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const suite = await loadVisibleSuite(params.id, session);

    const rbac = {
      visibility: suite.visibility as "private" | "public",
      createdBy: suite.createdBy,
    };

    // Content edits (name / description / timeout) vs flag edits
    // (enabled / visibility) use the two distinct permission gates,
    // matching the convention from skills / mcp / agent routes.
    const contentEdit =
      body.name !== undefined
      || body.description !== undefined
      || body.timeoutSec !== undefined;
    const flagEdit =
      body.enabled !== undefined || body.visibility !== undefined;

    if (contentEdit && !canEditResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot edit this verification suite.",
      );
    }
    if (flagEdit && !canChangeVisibility(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled.",
      );
    }

    const updates: Record<string, unknown> = { updatedBy: session.user.id };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.visibility !== undefined) updates.visibility = body.visibility;
    if (body.timeoutSec !== undefined) updates.timeoutSec = body.timeoutSec;
    updates.updatedAt = sql`CURRENT_TIMESTAMP`;

    try {
      const [updated] = await db
        .update(VerificationSuiteTable)
        .set(updates)
        .where(eq(VerificationSuiteTable.id, suite.id))
        .returning();
      // Keep response shape aligned with GET-by-id / GET-list so the
      // client store doesn't drop `caseCount` on optimistic upsert.
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(VerificationCaseTable)
        .where(eq(VerificationCaseTable.suiteId, suite.id));
      return NextResponse.json({ ...updated, caseCount: count });
    } catch (err) {
      if (isUniqueViolation(err) && body.name) {
        throw new ApiError(
          "CONFLICT",
          409,
          `A verification suite named "${body.name}" already exists.`,
        );
      }
      throw err;
    }
  },
);

// DELETE /api/verification-suites/[id]
// Cascade: cases + runs + case_results all drop via ON DELETE CASCADE.

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadVisibleSuite(params.id, session);
    const rbac = {
      visibility: suite.visibility as "private" | "public",
      createdBy: suite.createdBy,
    };
    if (!canDeleteResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this verification suite.",
      );
    }
    await db
      .delete(VerificationSuiteTable)
      .where(eq(VerificationSuiteTable.id, suite.id));
    return new NextResponse(null, { status: 204 });
  },
);
