/**
 * PATCH /api/artifacts/[id] handler core. Wraps `service.updateNode`
 * (tree metadata only — name / description / parent / order /
 * visibility) and re-assembles the render-ready bundle so the
 * response matches GET / save / refresh.
 *
 * PATCH does NOT cover workflow changes — those go through a fresh
 * save from a new chat outcome. See docs/workflow.md.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { WorkflowTable } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/route-handlers";
import type { CanonicalWorkflowSpec, CanonicalNode } from "@/lib/workflows/spec/schema";
import { validate } from "@/lib/workflows/spec/validate";
import { buildArtifactBundle, type ArtifactBundle } from "./bundle";
import { getArtifactBundle } from "./get-artifact";
import { getNode, updateNode, type UpdateNodeInput } from "./service";

export interface UpdateArtifactInput extends UpdateNodeInput {
  workflowSpec?: CanonicalWorkflowSpec;
}

/**
 * Apply a partial update and return the render-ready bundle.
 *
 * Supports updating both tree metadata (name, description, parent,
 * visibility, viewMode) and the backing `workflow.spec`.
 *
 * Throws `ApiError(404)` when the artifact doesn't exist or isn't
 * owned by `ownerId` (propagated from `service.updateNode`).
 */
export async function updateArtifact(
  id: string,
  patch: UpdateArtifactInput,
  ownerId: string,
): Promise<ArtifactBundle> {
  if (patch.workflowSpec !== undefined) {
    const current = await getNode(id, ownerId);
    if (!current.workflowId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Artifact does not have a backing workflow to update",
      );
    }
    // Validate spec schema & DAG integrity before persisting
    try {
      validate(patch.workflowSpec);
    } catch (err) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        `Workflow spec validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await db
      .update(WorkflowTable)
      .set({
        spec: patch.workflowSpec,
        updatedAt: new Date(),
      })
      .where(eq(WorkflowTable.id, current.workflowId));
  }

  const { workflowSpec: _, ...nodePatch } = patch;
  if (Object.keys(nodePatch).length > 0) {
    await updateNode(id, nodePatch, ownerId);
  }

  // Re-load the full bundle so the response matches GET — bundle
  // assembly does its own workflow lookup + execution, duplicating
  // that here would be brittle.
  return getArtifactBundle(id, ownerId);
}

/**
 * Test-friendly variant — accepts the bundle deps directly so tests
 * don't need to mock `@/lib/db` indirectly through
 * `getArtifactBundle`. Production code calls the version above.
 */
export async function updateArtifactWithDeps(
  id: string,
  patch: UpdateArtifactInput,
  ownerId: string,
  performUpdate: (
    id: string,
    patch: UpdateNodeInput,
    ownerId: string,
  ) => Promise<void>,
  bundleDeps: Parameters<typeof buildArtifactBundle>[2],
): Promise<ArtifactBundle> {
  const { workflowSpec: _, ...nodePatch } = patch;
  if (Object.keys(nodePatch).length > 0) {
    await performUpdate(id, nodePatch, ownerId);
  }
  return buildArtifactBundle(id, ownerId, bundleDeps);
}

/**
 * Update a single workflow node atomically.
 * Resolves the "Lost Update" risk by reading the latest spec and replacing
 * the node inside a database transaction.
 */
export async function updateWorkflowNode(
  artifactId: string,
  nodeId: number,
  nodePatch: CanonicalNode,
  ownerId: string,
): Promise<ArtifactBundle> {
  return db.transaction(async (tx) => {
    // 1. Verify artifact ownership and workflow existence
    const artifact = await getNode(artifactId, ownerId);
    if (!artifact.workflowId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Artifact does not have a backing workflow to update",
      );
    }

    // 2. Fetch the latest workflow spec and lock it for update
    const [workflow] = await tx
      .select()
      .from(WorkflowTable)
      .where(eq(WorkflowTable.id, artifact.workflowId))
      .limit(1)
      .for("update");

    if (!workflow) {
      throw new ApiError("NOT_FOUND", 404, "Backing workflow not found");
    }

    const currentSpec = workflow.spec as CanonicalWorkflowSpec;

    // 3. Find and replace the node
    const nodeIndex = currentSpec.nodes.findIndex((n) => n.id === nodeId);
    if (nodeIndex === -1) {
      throw new ApiError("NOT_FOUND", 404, `Node ${nodeId} not found in workflow`);
    }

    const newNodes = [...currentSpec.nodes];
    newNodes[nodeIndex] = nodePatch;

    const newSpec: CanonicalWorkflowSpec = {
      ...currentSpec,
      nodes: newNodes,
    };

    // 4. Validate the modified DAG
    try {
      validate(newSpec);
    } catch (err) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        `Workflow spec validation failed after node update: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 5. Save the updated spec
    await tx
      .update(WorkflowTable)
      .set({
        spec: newSpec,
        updatedAt: new Date(),
      })
      .where(eq(WorkflowTable.id, workflow.id));

    return getArtifactBundle(artifactId, ownerId);
  });
}
