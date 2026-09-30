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
import { ArtifactTable, WorkflowTable } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/route-handlers";
import { logger } from "@/lib/observability/logger";
import type { CanonicalWorkflowSpec } from "@/lib/workflows/spec/schema";

import type { ArtifactBundle, BundleDeps } from "./bundle";
import { productionDeps } from "./get-artifact";
import { buildArtifactBundle } from "./bundle";

export interface UpdateWorkflowInputsResult {
  updatedKeys: string[];
  ignoredKeys: string[];
}

/**
 * Execute the artifact's workflow live, persist the output as the
 * current snapshot, and return the bundle (with `fromSnapshot=false`
 * and the fresh data).
 *
 * Throws:
 *   - `ApiError(NOT_FOUND, 404)` if the artifact doesn't exist
 *   - `ApiError(FORBIDDEN, 403)` if `ownerId` is not the creator
 */
export interface SaveSnapshotDeps {
  db?: typeof db;
  bundleDeps?: BundleDeps;
}

export async function saveSnapshot(
  artifactId: string,
  ownerId: string,
  inputValues?: Record<string, unknown>,
  directSnapshot?: Record<string, unknown>,
  deps?: SaveSnapshotDeps,
): Promise<ArtifactBundle> {
  const database = deps?.db ?? db;
  const bundleDeps = deps?.bundleDeps ?? productionDeps;

  // Ownership check — the artifact must exist and belong to ownerId.
  const rows = await database
    .select({
      type: ArtifactTable.type,
      createdBy: ArtifactTable.createdBy,
      config: ArtifactTable.config,
      workflowId: ArtifactTable.workflowId,
    })
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

  // If directSnapshot is provided (e.g. from current live session or edited slide doc),
  // persist directly to DB without re-executing the workflow from stale cache.
  if (directSnapshot !== undefined) {
    const snapshotAt = new Date();
    const isSlide = artifact.type === "slide";
    const currentConfig = (artifact.config as Record<string, unknown> | null) ?? {};

    // CONTRACT: Only slide artifacts store their presentation document in config.doc.
    // Non-slide artifacts (e.g. charts, tables, html) must NOT have config polluted.
    const updatePayload: {
      snapshot: Record<string, unknown>;
      snapshotAt: Date;
      config?: Record<string, unknown>;
    } = {
      snapshot: directSnapshot,
      snapshotAt,
    };
    if (isSlide) {
      updatePayload.config = { ...currentConfig, doc: directSnapshot };
    }

    await database
      .update(ArtifactTable)
      .set(updatePayload)
      .where(eq(ArtifactTable.id, artifactId));

    // Update value fields in workflow spec if inputValues provided
    let inputUpdateResult: UpdateWorkflowInputsResult | undefined;
    if (inputValues && artifact.workflowId) {
      inputUpdateResult = await updateWorkflowInputValues(artifact.workflowId, inputValues, database);
    }

    const bundle = await buildArtifactBundle(
      artifactId,
      ownerId,
      bundleDeps,
      { preferSnapshot: true, inputValues },
    );
    bundle.data = directSnapshot;
    bundle.fromSnapshot = true;
    bundle.snapshotAt = snapshotAt.toISOString();
    if (inputUpdateResult && inputUpdateResult.ignoredKeys.length > 0) {
      bundle.ignoredInputKeys = inputUpdateResult.ignoredKeys;
    }
    return bundle;
  }

  // Fallback path: directSnapshot was not provided by caller.
  // Execute the workflow live to get the current output.
  // forceFresh=false: use SQL Parquet cache where possible.
  const bundle = await buildArtifactBundle(
    artifactId,
    ownerId,
    bundleDeps,
    { forceFresh: false, inputValues },
  );

  // Persist snapshot only when data is available.
  if (bundle.data !== undefined) {
    const isSlide = artifact.type === "slide";
    const snapshotData = bundle.data as Record<string, unknown>;
    const snapshotAt = bundle.executedAt
      ? new Date(bundle.executedAt)
      : new Date();
    const currentConfig = (artifact.config as Record<string, unknown> | null) ?? {};

    const updatePayload: {
      snapshot: Record<string, unknown>;
      snapshotAt: Date;
      config?: Record<string, unknown>;
    } = {
      snapshot: snapshotData,
      snapshotAt,
    };
    if (isSlide) {
      updatePayload.config = { ...currentConfig, doc: snapshotData };
    }

    await database
      .update(ArtifactTable)
      .set(updatePayload)
      .where(eq(ArtifactTable.id, artifactId));

    // Update value fields in workflow spec if inputValues provided
    if (inputValues && bundle.workflow?.id) {
      const inputUpdateResult = await updateWorkflowInputValues(bundle.workflow.id, inputValues, database);
      if (inputUpdateResult.ignoredKeys.length > 0) {
        bundle.ignoredInputKeys = inputUpdateResult.ignoredKeys;
      }
    }
  }

  return bundle;
}

/**
 * Update default / value fields in workflow spec input_schema for provided inputValues.
 * Reports which keys were applied and which were ignored due to missing schema definitions.
 */
export async function updateWorkflowInputValues(
  workflowId: string,
  inputValues: Record<string, unknown>,
  database: typeof db = db,
): Promise<UpdateWorkflowInputsResult> {
  const wfRows = await database
    .select({ spec: WorkflowTable.spec })
    .from(WorkflowTable)
    .where(eq(WorkflowTable.id, workflowId))
    .limit(1);

  const spec = (wfRows[0]?.spec ?? {}) as Record<string, unknown>;
  const inputSchema = (spec.input_schema ?? {}) as Record<string, unknown>;
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;

  const updatedKeys: string[] = [];
  const ignoredKeys: string[] = [];

  for (const k of Object.keys(inputValues)) {
    if (properties[k]) {
      properties[k].value = inputValues[k];
      updatedKeys.push(k);
    } else {
      ignoredKeys.push(k);
    }
  }

  if (ignoredKeys.length > 0) {
    logger.warn(
      {
        event: "workflow_inputs_schema_mismatch",
        workflowId,
        ignoredKeys,
        updatedKeys,
        availableKeys: Object.keys(properties),
      },
      `[updateWorkflowInputValues] Input keys not defined in workflow input_schema.properties were ignored: ${ignoredKeys.join(", ")}`,
    );
  }

  if (updatedKeys.length > 0) {
    spec.input_schema = { ...inputSchema, properties };
    await database
      .update(WorkflowTable)
      .set({ spec: spec as CanonicalWorkflowSpec, updatedAt: new Date() })
      .where(eq(WorkflowTable.id, workflowId));
  }

  return { updatedKeys, ignoredKeys };
}
