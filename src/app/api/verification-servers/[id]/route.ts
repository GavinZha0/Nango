import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { VerificationSuiteTable } from "@/lib/db/schema";
import { withEditor } from "@/lib/http/route-handlers";

const ROUTE = "/api/verification-servers/[id]";

// DELETE /api/verification-servers/[id]
// Deletes all verification suites (tools) and cases associated with this MCP server.
export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params }) => {
    const { id } = params;

    // Delete all verification suites associated with this server.
    // Drizzle Cascade constraints will automatically clean up all verification cases and results.
    await db
      .delete(VerificationSuiteTable)
      .where(eq(VerificationSuiteTable.mcpServerId, id));

    return new NextResponse(null, { status: 204 });
  },
);
