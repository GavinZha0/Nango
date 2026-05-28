import "server-only";

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable, DataSourceTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { visibilitySql } from "@/lib/auth/permissions";
import { parseBody } from "@/lib/http/validation";
import { isSupportedDataSource } from "@/lib/data-sources/types";
import { createDataSourceSchema } from "@/lib/data-sources/validation";

const ROUTE = "/api/data-sources";

// GET /api/data-sources
// Visibility-aware list: own rows + public rows for non-admins;
// everything for admins. Used by DataSourcePanel and by the agent
// editor's "bind data sources" picker. We DO NOT redact host /
// credentialId here — caller is editor+ via the panel UI; if a user
// role ever needs the list we would project a slimmer shape.

export const GET = withSession(ROUTE, async ({ session }) => {
  const rows = await db
    .select()
    .from(DataSourceTable)
    .where(
      visibilitySql(
        session,
        DataSourceTable.visibility,
        DataSourceTable.createdBy,
      ),
    )
    .orderBy(desc(DataSourceTable.createdAt));

  return NextResponse.json(rows);
});

// POST /api/data-sources
// Editor+ only. Validates that the bound credential exists; the
// credential's `provider` field is informational only and is NOT
// cross-checked against the data source's provider — same DB account
// often spans heterogeneous engines (e.g. one ops user covering both
// MariaDB and Vertica). The shared DatabaseConnectionBase payload
// shape (`{username, password}`) makes this safe at runtime.

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createDataSourceSchema);

  if (!isSupportedDataSource(body.provider)) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Provider "${body.provider}" is not registered.`,
    );
  }

  // Validate credential: must exist and be enabled. We deliberately
  // DO NOT compare cred.provider to body.provider — see the section
  // header for the rationale.
  const [cred] = await db
    .select({
      id: CredentialTable.id,
      enabled: CredentialTable.enabled,
    })
    .from(CredentialTable)
    .where(eq(CredentialTable.id, body.credentialId))
    .limit(1);
  if (!cred) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      `Credential ${body.credentialId} not found.`,
    );
  }

  const [row] = await db
    .insert(DataSourceTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      provider: body.provider,
      credentialId: body.credentialId,
      host: body.host,
      port: body.port,
      database: body.database,
      params: body.params ?? {},
      readOnly: body.readOnly ?? true,
      tableAllowlist: body.tableAllowlist ?? null,
      tableDenylist: body.tableDenylist ?? [],
      enabled: body.enabled ?? true,
      visibility: body.visibility ?? "private",
      createdBy: session.user.id,
      updatedBy: session.user.id,
    })
    .returning();

  return NextResponse.json(row, { status: 201 });
});
