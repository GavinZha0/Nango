/**
 * Production `BundleDeps` wiring + thin entrypoint used by the
 * GET /api/artifacts/[id] route handler.
 *
 * The bundle assembler (`bundle.ts`) is dependency-injected; this
 * file fixes those dependencies for the production code path:
 *   - DB-backed artifact + workflow loaders via Drizzle
 *   - `executeWorkflow` STUB returning null until W1.6.x wires the
 *     tool registry + runner adapter (issue tracked in D31
 *     follow-up)
 *
 * Splitting the prod wiring from the assembler keeps `bundle.ts`
 * test-friendly — tests inject their own deps and never touch DB
 * or engine.
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  ArtifactTable,
  WorkflowTable,
  type ArtifactEntity,
  type WorkflowEntity,
} from "@/lib/db/schema";

import {
  buildArtifactBundle,
  type ArtifactBundle,
  type BundleDeps,
} from "./bundle";
import { executeWorkflow } from "./execute-workflow";

/**
 * Production entry — used by the route handler. Wraps
 * `buildArtifactBundle` with DB + (stubbed) engine deps.
 */
export async function getArtifactBundle(
  artifactId: string,
  ownerId: string,
): Promise<ArtifactBundle> {
  return buildArtifactBundle(artifactId, ownerId, productionDeps);
}

// ─── Production deps ───────────────────────────────────────────────────

/**
 * Exported so refresh-artifact.ts can reuse the same DB loaders +
 * real executor without duplicating wiring. Refresh passes
 * `{ forceFresh: true }` to `buildArtifactBundle`; the executor
 * itself is the same — L2 cache lookup (when it exists) will
 * branch on `forceFresh`.
 */
export const productionDeps: BundleDeps = {
  getArtifact: loadArtifact,
  getWorkflow: loadWorkflow,
  executeWorkflow,
};

async function loadArtifact(
  id: string,
  ownerId: string,
): Promise<ArtifactEntity | null> {
  const rows = await db
    .select()
    .from(ArtifactTable)
    .where(
      and(eq(ArtifactTable.id, id), eq(ArtifactTable.createdBy, ownerId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function loadWorkflow(id: string): Promise<WorkflowEntity | null> {
  const rows = await db
    .select()
    .from(WorkflowTable)
    .where(eq(WorkflowTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}


