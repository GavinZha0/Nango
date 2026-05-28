import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable, DataSourceTable } from "@/lib/db/schema";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import {
  canChangeVisibility,
  canDeleteResource,
  canEditResource,
  canViewResource,
} from "@/lib/auth/permissions";
import { parseBody } from "@/lib/http/validation";
import { invalidateForDataSourceChange } from "@/lib/cache/invalidation";
import { purgeDatasetsForDataSource } from "@/lib/data-sources/cache";
import { updateDataSourceSchema } from "@/lib/data-sources/validation";
import { isSupportedDataSource } from "@/lib/data-sources/types";

const ROUTE = "/api/data-sources/[id]";

// GET /api/data-sources/[id]

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;
    const [row] = await db
      .select()
      .from(DataSourceTable)
      .where(eq(DataSourceTable.id, id))
      .limit(1);
    if (!row) {
      throw new ApiError("NOT_FOUND", 404, "Data source not found.");
    }
    if (
      !canViewResource(
        {
          source: undefined,
          visibility: row.visibility as "private" | "public",
          createdBy: row.createdBy,
        },
        session,
      )
    ) {
      // Same status as not-found so we don't leak existence to a
      // user who can't see the row.
      throw new ApiError("NOT_FOUND", 404, "Data source not found.");
    }
    return NextResponse.json(row);
  },
);

// PATCH /api/data-sources/[id]
// Mirror the MCP server pattern: split content edits (anyone in
// editor role with public/own access) from visibility / enabled
// (creator or admin). `name` cannot be patched — see validation.ts.

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = params;
    const [existing] = await db
      .select({
        id: DataSourceTable.id,
        provider: DataSourceTable.provider,
        createdBy: DataSourceTable.createdBy,
        visibility: DataSourceTable.visibility,
      })
      .from(DataSourceTable)
      .where(eq(DataSourceTable.id, id))
      .limit(1);
    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Data source not found.");
    }

    const body = await parseBody(req, updateDataSourceSchema);

    const rbac = {
      visibility: existing.visibility as "private" | "public",
      createdBy: existing.createdBy,
    };

    const editsContent =
      body.description !== undefined ||
      body.provider !== undefined ||
      body.credentialId !== undefined ||
      body.host !== undefined ||
      body.port !== undefined ||
      body.database !== undefined ||
      body.params !== undefined ||
      body.readOnly !== undefined ||
      body.tableAllowlist !== undefined ||
      body.tableDenylist !== undefined;
    if (editsContent && !canEditResource(rbac, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot edit this data source.",
      );
    }
    if (
      (body.visibility !== undefined || body.enabled !== undefined) &&
      !canChangeVisibility(rbac, session)
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can change visibility / enabled.",
      );
    }

    // Validate provider when caller changes it: must be a registered
    // adapter id. Cache invalidation is intentionally NOT triggered
    // here — flipping provider mid-life can leave stale Parquet
    // snapshots under the same `name`; a separate admin "purge cache"
    // workflow is on the roadmap. The runtime always re-applies the
    // new provider on the next cache miss.
    if (body.provider !== undefined && !isSupportedDataSource(body.provider)) {
      throw new ApiError(
        "VALIDATION_FAILED",
        400,
        `Provider "${body.provider}" is not registered.`,
      );
    }

    // Re-validate credential when caller swaps it: must exist. We
    // deliberately DO NOT cross-check cred.provider against the data
    // source's provider — see POST /api/data-sources for rationale
    // (same DB account often spans engines like MariaDB + Vertica).
    if (body.credentialId !== undefined) {
      const [cred] = await db
        .select({ id: CredentialTable.id })
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
    }

    const updates: Partial<typeof DataSourceTable.$inferInsert> = {
      updatedAt: new Date(),
      updatedBy: session.user.id,
    };
    if (body.description !== undefined) updates.description = body.description;
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.credentialId !== undefined) updates.credentialId = body.credentialId;
    if (body.host !== undefined) updates.host = body.host;
    if (body.port !== undefined) updates.port = body.port;
    if (body.database !== undefined) updates.database = body.database;
    if (body.params !== undefined) updates.params = body.params;
    if (body.readOnly !== undefined) updates.readOnly = body.readOnly;
    if (body.tableAllowlist !== undefined) {
      updates.tableAllowlist = body.tableAllowlist;
    }
    if (body.tableDenylist !== undefined) {
      updates.tableDenylist = body.tableDenylist;
    }
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.visibility !== undefined) updates.visibility = body.visibility;

    const [row] = await db
      .update(DataSourceTable)
      .set(updates)
      .where(eq(DataSourceTable.id, id))
      .returning();

    // Any field change might affect what an agent sees — connection,
    // policy, enabled, or description (which appears in the injected
    // prompt block). Evict bound agents' cached specs.
    await invalidateForDataSourceChange(id);

    return NextResponse.json(row);
  },
);

// DELETE /api/data-sources/[id]

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const { id } = params;
    const [existing] = await db
      .select({
        id: DataSourceTable.id,
        createdBy: DataSourceTable.createdBy,
        visibility: DataSourceTable.visibility,
      })
      .from(DataSourceTable)
      .where(eq(DataSourceTable.id, id))
      .limit(1);
    if (!existing) {
      throw new ApiError("NOT_FOUND", 404, "Data source not found.");
    }
    if (
      !canDeleteResource(
        {
          visibility: existing.visibility as "private" | "public",
          createdBy: existing.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "Only the creator or an admin can delete this data source.",
      );
    }

    // Order matters:
    //   1. Invalidate agent specs that bind this source (reverse-
    //      lookup needs the row's data_source_id, which set-null'd
    //      junctions still carry IF we read before delete).
    //   2. Purge cached parquet datasets that came from this row
    //      (sidecar.dataSourceId match).
    //   3. Delete the row last.
    await invalidateForDataSourceChange(id);
    await purgeDatasetsForDataSource(id);
    await db.delete(DataSourceTable).where(eq(DataSourceTable.id, id));

    return new NextResponse(null, { status: 204 });
  },
);
