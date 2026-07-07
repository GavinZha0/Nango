import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { db } from "@/lib/db";
import { VerificationSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { isAdmin } from "@/lib/auth/permissions";

const ROUTE = "/api/verification-servers/[id]/visibility";

const patchSchema = z
  .object({
    visibility: z.enum(["private", "public"]),
  })
  .strict();

// PATCH /api/verification-servers/[id]/visibility
// Batch updates the verification visibility (all underling suites) of an MCP server.
export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, patchSchema);

    // Check if there are any suites under this server created by the current user
    const [ownSuite] = await db
      .select()
      .from(VerificationSuiteTable)
      .where(
        and(
          eq(VerificationSuiteTable.mcpServerId, params.id),
          eq(VerificationSuiteTable.createdBy, session.user.id),
        )
      )
      .limit(1);

    const hasOwnSuites = !!ownSuite;
    const isAllowed = hasOwnSuites || isAdmin(session);

    if (!isAllowed) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You do not have permission to change the verification visibility of this server because you do not own any suites under it.",
      );
    }

    // Batch update visibility for all verification suites associated with this MCP server
    // Regular editors can only update their own suites, while admin can update all.
    const updateFilter = isAdmin(session)
      ? eq(VerificationSuiteTable.mcpServerId, params.id)
      : and(
          eq(VerificationSuiteTable.mcpServerId, params.id),
          eq(VerificationSuiteTable.createdBy, session.user.id),
        );

    await db
      .update(VerificationSuiteTable)
      .set({
        visibility: body.visibility,
        updatedBy: session.user.id,
      })
      .where(updateFilter);

    return new NextResponse(null, { status: 204 });
  },
);
