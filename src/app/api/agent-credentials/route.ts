/**
 * GET /api/agent-credentials
 */
import "server-only";

import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";

export const dynamic = "force-dynamic";

export const GET = withSession("/api/agent-credentials", async () => {
  const rows = await db
    .select({
      id: CredentialTable.id,
      name: CredentialTable.name,
      provider: CredentialTable.provider,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.serviceType, "agent"),
        eq(CredentialTable.enabled, true),
      )
    );

  return NextResponse.json(rows);
});
