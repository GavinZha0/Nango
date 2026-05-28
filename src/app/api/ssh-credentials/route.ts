/**
 * GET /api/ssh-credentials
 */

import "server-only";

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";
import { withSession } from "@/lib/http/route-handlers";

export const dynamic = "force-dynamic";

export const GET = withSession("/api/ssh-credentials", async () => {
  const rows = await db
    .select({
      id: CredentialTable.id,
      name: CredentialTable.name,
      type: CredentialTable.type,
    })
    .from(CredentialTable)
    .where(
      and(
        inArray(CredentialTable.type, ["basic_auth", "private_key"]),
        eq(CredentialTable.enabled, true),
      ),
    );

  return NextResponse.json(rows);
});
