/**
 * POST /api/artifacts/[id]/snapshot handler core.
 *
 * Executes the artifact's workflow live and persists the result as the
 * current snapshot. Only the artifact owner (or an admin) may call this.
 *
 * After saving, the artifact row's `snapshot` + `snapshot_at` are
 * updated but `view_mode` is left unchanged — the caller switches
 * modes separately via PATCH if desired.
 *
 * See docs/workflow.md.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { ArtifactTable } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/route-handlers";

import type { ArtifactBundle } from "./bundle";
import { productionDeps } from "./get-artifact";
import { buildArtifactBundle } from "./bundle";

/**
 * Execute the artifact's workflow live, persist the output as the
 * current snapshot, and return the bundle (with `fromSnapshot=false`
 * and the fresh data).
 *
 * Throws:
 *   - `ApiError(NOT_FOUND, 404)` if the artifact doesn't exist
 *   - `ApiError(FORBIDDEN, 403)` if `ownerId` is not the creator
 */
export async function saveSnapshot(
  artifactId: string,
  ownerId: string,
): Promise<ArtifactBundle> {
  // Ownership check — the artifact must exist and belong to ownerId.
  const rows = await db
    .select({ createdBy: ArtifactTable.createdBy })
    .from(ArtifactTable)
    .where(eq(ArtifactTable.id, artifactId))
    .limit(1);

  const artifact = rows[0] ?? null;
  if (artifact === null) {
    throw new ApiError("NOT_FOUND", 404, "Artifact not found");
  }
  if (artifact.createdBy !== ownerId) {
    throw new ApiError(
      "FORBIDDEN",
      403,
      "Only the artifact owner can save a snapshot",
    );
  }

  // Execute the workflow live to get the current output.
  // forceFresh=false: use SQL Parquet cache where possible.
  const bundle = await buildArtifactBundle(
    artifactId,
    ownerId,
    productionDeps,
    { forceFresh: false },
  );

  // Persist snapshot only when data is available.
  if (bundle.data !== undefined) {
    await db
      .update(ArtifactTable)
      .set({
        snapshot: bundle.data as Record<string, unknown>,
        snapshotAt: bundle.executedAt
          ? new Date(bundle.executedAt)
          : new Date(),
      })
      .where(eq(ArtifactTable.id, artifactId));
  }

  return bundle;
}
