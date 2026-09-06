import "server-only";

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { VerificationSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { canDeleteResource, type ResourceWithRBAC } from "@/lib/auth/permissions";

const ROUTE = "/api/verification-servers/[id]";

const serverIdSchema = z.string().uuid();

// DELETE /api/verification-servers/[id]
// Bulk cleanup of the verification suites bound to an MCP server.
// CONTRACT: the suite-level delete rule applies per row (author or admin,
// via canDeleteResource) — an editor must never cascade away suites they
// do not own. Cases/runs/results die with their suite via FK cascade,
// which is legal because a suite author already holds case-delete rights
// inside their own suites (verification-cases/[id] DELETE).
export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ session, params }) => {
    const { id } = params;

    // SECURITY: reject non-uuid ids before they reach Postgres — a uuid
    // column compared against an arbitrary string raises 22P02 (unhandled
    // 500). The left panel's detached groups carry synthetic
    // `detached:<name>` keys that must never reach this endpoint.
    if (!serverIdSchema.safeParse(id).success) {
      throw new ApiError("NOT_FOUND", 404, "MCP server not found.");
    }

    const suites = await db
      .select({
        id: VerificationSuiteTable.id,
        createdBy: VerificationSuiteTable.createdBy,
        visibility: VerificationSuiteTable.visibility,
      })
      .from(VerificationSuiteTable)
      .where(eq(VerificationSuiteTable.mcpServerId, id));

    const deletable = suites.filter((suite) =>
      canDeleteResource(suite as unknown as ResourceWithRBAC, session),
    );

    if (deletable.length > 0) {
      await db
        .delete(VerificationSuiteTable)
        .where(
          inArray(
            VerificationSuiteTable.id,
            deletable.map((suite) => suite.id),
          ),
        );
    }

    return NextResponse.json({
      deleted: deletable.length,
      skipped: suites.length - deletable.length,
    });
  },
);
