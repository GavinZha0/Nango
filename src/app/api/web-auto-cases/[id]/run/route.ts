import "server-only";

import { NextResponse } from "next/server";

import { canViewResource, ResourceWithRBAC } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoCaseTable, WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { runWebAutoCase } from "@/lib/web-auto/orchestrator";
import { eq } from "drizzle-orm";

const ROUTE = "/api/web-auto-cases/[id]/run";

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = await params;
    const caseId = Number(id);
    if (!Number.isSafeInteger(caseId) || caseId <= 0) {
      throw new ApiError("VALIDATION_FAILED", 400, "Invalid case ID format.");
    }

    // Load case and parent suite
    const [caseRow] = await db
      .select()
      .from(WebAutoCaseTable)
      .where(eq(WebAutoCaseTable.id, caseId));

    if (!caseRow) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto case not found.");
    }

    const [suite] = await db
      .select()
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, caseRow.suiteId));

    if (!suite || !canViewResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found or access denied.");
    }

    if (!suite.mcpServerId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Suite does not have a Playwright MCP server configured.",
      );
    }

    if (!caseRow.scriptContent) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Case has no script content to execute.",
      );
    }

    const outcome = await runWebAutoCase({
      caseId: caseRow.id,
      suiteId: suite.id,
      suite,
      case: caseRow,
      ownerId: session.user.id,
    });

    return NextResponse.json(outcome);
  },
);
