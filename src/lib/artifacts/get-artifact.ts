/**
 * Production `BundleDeps` wiring for `GET /api/artifacts/[id]`. The
 * bundle assembler is dependency-injected so `bundle.ts` stays
 * test-friendly; this file pins the DB loaders + real
 * `executeWorkflow` adapter for the production code path.
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

/** Production entry — used by the route handler. */
export async function getArtifactBundle(
  artifactId: string,
  ownerId: string,
): Promise<ArtifactBundle> {
  return buildArtifactBundle(artifactId, ownerId, productionDeps);
}

/**
 * Shared production deps — re-used by `refresh-artifact.ts` which
 * only differs in passing `{ forceFresh: true }` to the assembler.
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
