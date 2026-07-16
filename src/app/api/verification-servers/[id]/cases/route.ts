import "server-only";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { VerificationCaseTable, VerificationSuiteTable, McpServerTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { and, eq } from "drizzle-orm";
import { visibilitySql } from "@/lib/auth/permissions";

const ROUTE = "/api/verification-servers/[id]/cases";

// GET /api/verification-servers/[id]/cases
// List all cases for a specific MCP server by joining verification_case and verification_suite.
export const GET = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const [server] = await db
      .select()
      .from(McpServerTable)
      .where(
        and(
          eq(McpServerTable.id, params.id),
          visibilitySql(
            session,
            McpServerTable.visibility,
            McpServerTable.createdBy,
          )
        )
      )
      .limit(1);

    if (!server) {
      throw new ApiError(
        "NOT_FOUND",
        404,
        `MCP server with ID "${params.id}" not found or access denied.`
      );
    }

    const cases = await db
      .select({
        id: VerificationCaseTable.id,
        suiteId: VerificationCaseTable.suiteId,
        name: VerificationCaseTable.name,
        input: VerificationCaseTable.input,
        assertions: VerificationCaseTable.assertions,
        enabled: VerificationCaseTable.enabled,
        createdAt: VerificationCaseTable.createdAt,
        updatedAt: VerificationCaseTable.updatedAt,
        toolName: VerificationCaseTable.toolName,
        mcpServerId: VerificationSuiteTable.mcpServerId,
        suiteVisibility: VerificationSuiteTable.visibility,
        suiteCreatedBy: VerificationSuiteTable.createdBy,
        suiteName: VerificationSuiteTable.name,
      })
      .from(VerificationCaseTable)
      .innerJoin(
        VerificationSuiteTable,
        eq(VerificationCaseTable.suiteId, VerificationSuiteTable.id)
      )
      .where(
        and(
          eq(VerificationSuiteTable.mcpServerId, params.id),
          visibilitySql(
            session,
            VerificationSuiteTable.visibility,
            VerificationSuiteTable.createdBy,
          ),
        ),
      );

    return NextResponse.json(cases);
  }
);
