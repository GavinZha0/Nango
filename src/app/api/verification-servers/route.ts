import "server-only";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { McpServerTable, VerificationSuiteTable } from "@/lib/db/schema";
import { withEditor } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import { and, asc, sql } from "drizzle-orm";

const ROUTE = "/api/verification-servers";

// GET /api/verification-servers
// Returns MCP servers that have verification cases (alphabetical). Editor-gated.
export const GET = withEditor(ROUTE, async ({ session }) => {
  const rows = await db
    .select({
      id: McpServerTable.id,
      name: McpServerTable.name,
      serverTitle: McpServerTable.serverTitle,
      serverDescription: McpServerTable.serverDescription,
      enabled: McpServerTable.enabled,
      visibility: McpServerTable.visibility,
      createdBy: McpServerTable.createdBy,
      // Get logical verification visibility from the first bound suite (default 'private')
      verificationVisibility: sql<string>`coalesce(
        (select "verification_suite"."visibility" from "verification_suite"
         where "verification_suite"."mcp_server_id" = "mcp_server"."id"
           and ${visibilitySql(
             session,
             VerificationSuiteTable.visibility,
             VerificationSuiteTable.createdBy,
           )}
         limit 1),
        'private'
      )`,
      // Checks if the current user has created at least one suite under this server
      hasOwnSuites: sql<boolean>`exists (
        select 1 from "verification_suite"
        where "verification_suite"."mcp_server_id" = "mcp_server"."id"
          and "verification_suite"."created_by" = ${session.user.id}
      )`,
      // Aggregates total suite (tool) count with at least one case (visible to current user).
      caseCount: sql<number>`(
        select count(distinct "verification_suite"."id")::int from "verification_suite"
        inner join "verification_case" on "verification_case"."suite_id" = "verification_suite"."id"
        where "verification_suite"."mcp_server_id" = "mcp_server"."id"
          and ${visibilitySql(
            session,
            VerificationSuiteTable.visibility,
            VerificationSuiteTable.createdBy,
          )}
      )`,
    })
    .from(McpServerTable)
    .where(
      and(
        visibilitySql(
          session,
          McpServerTable.visibility,
          McpServerTable.createdBy,
        ),
        // INNER JOIN equivalent filter to load only servers with visible cases.
        sql`exists (
          select 1 from "verification_suite"
          inner join "verification_case" on "verification_case"."suite_id" = "verification_suite"."id"
          where "verification_suite"."mcp_server_id" = "mcp_server"."id"
            and ${visibilitySql(
              session,
              VerificationSuiteTable.visibility,
              VerificationSuiteTable.createdBy,
            )}
        )`
      )
    )
    .orderBy(asc(McpServerTable.name));

  return NextResponse.json(rows);
});
