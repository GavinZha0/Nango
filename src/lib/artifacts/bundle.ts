/**
 * Render-ready artifact bundle assembler — shared by the four
 * artifact endpoints (save / get / update / refresh) so the client
 * gets the same shape regardless of which one fired. DI-shaped;
 * production wiring lives in `get-artifact.ts`. See docs/workflow.md.
 */

import "server-only";

import { ApiError } from "@/lib/http/route-handlers";
import type { ArtifactEntity, WorkflowEntity } from "@/lib/db/schema";
import type { CanonicalWorkflowSpec } from "@/lib/workflows";

// ─── Public types ──────────────────────────────────────────────────────

export interface ArtifactBundle {
  node: ArtifactEntity;
  /** Present only when `node.workflowId` is set AND the workflow
   *  row was found. Folders + standalone artifacts omit this. */
  workflow?: {
    id: string;
    name: string;
    spec: CanonicalWorkflowSpec;
    /** Key in `spec.outputs` whose resolved value is the artifact's data. */
    outputField: string;
  };
  /** Present only when `deps.executeWorkflow` returned a non-null
   *  resolution. The artifact's renderable data. */
  data?: unknown;
  /** Whether the data came from cache (L2) vs a fresh execute. */
  fromCache?: boolean;
  /** ISO-8601 timestamp of the execution that produced `data`. */
  executedAt?: string;
}

export interface DataResolution {
  data: unknown;
  fromCache: boolean;
  executedAt: Date;
}

/**
 * Dependency surface. The route handler wires these to real DB
 * + engine; tests inject stubs.
 */
export interface BundleDeps {
  /** Load artifact row by id, with ownership check. Null = not
   *  found OR not owned by `ownerId`. */
  getArtifact(
    id: string,
    ownerId: string,
  ): Promise<ArtifactEntity | null>;
  /** Load workflow row by id. Null = not found. (No ownership check
   *  here — the artifact already established ownership.) */
  getWorkflow(id: string): Promise<WorkflowEntity | null>;
  /** Resolve the artifact's data via the workflow engine. Returns
   *  null when execution wasn't attempted or failed in a way the
   *  caller wants to surface as "data not available" rather than
   *  throw. `forceFresh: true` is a placeholder today (no L2 cache
   *  to bust yet) — the wiring is in place for when it lands. */
  executeWorkflow(args: {
    workflowId: string;
    spec: CanonicalWorkflowSpec;
    outputField: string;
    ownerId: string;
    forceFresh?: boolean;
    /** Used only on the recorded (`forceFresh: true`) path so the
     *  entity_run row surfaces "Refresh workflow: <name>". */
    workflowName?: string;
  }): Promise<DataResolution | null>;
}

export interface BundleOptions {
  /** Pass-through to `deps.executeWorkflow.forceFresh`. */
  forceFresh?: boolean;
}

// ─── Entry point ───────────────────────────────────────────────────────

/**
 * Build the render-ready bundle. Throws `ApiError(NOT_FOUND, 404)`
 * on not-found / access denied. Shape varies by node kind: folders
 * and standalone artifacts get `{ node }`; workflow-backed artifacts
 * get `{ node, workflow, [data, fromCache, executedAt] }`.
 */
export async function buildArtifactBundle(
  artifactId: string,
  ownerId: string,
  deps: BundleDeps,
  options?: BundleOptions,
): Promise<ArtifactBundle> {
  const node = await deps.getArtifact(artifactId, ownerId);
  if (node === null) {
    throw new ApiError("NOT_FOUND", 404, "Artifact not found");
  }
  if (node.kind === "folder" || node.workflowId === null) {
    return { node };
  }
  const workflow = await deps.getWorkflow(node.workflowId);
  if (workflow === null) {
    // Defensive: dangling FK after a partial delete / race.
    return { node };
  }
  const spec = workflow.spec as CanonicalWorkflowSpec;
  const outputField = node.workflowOutputField ?? pickFirstOutputKey(spec);
  if (outputField === null) {
    // Should be unreachable — validate.ts requires non-empty outputs.
    return {
      node,
      workflow: {
        id: workflow.id,
        name: workflow.name,
        spec,
        outputField: "",
      },
    };
  }

  const resolution = await deps.executeWorkflow({
    workflowId: workflow.id,
    spec,
    outputField,
    ownerId,
    workflowName: workflow.name,
    ...(options?.forceFresh === true && { forceFresh: true }),
  });

  const bundle: ArtifactBundle = {
    node,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      spec,
      outputField,
    },
  };
  if (resolution !== null) {
    bundle.data = resolution.data;
    bundle.fromCache = resolution.fromCache;
    bundle.executedAt = resolution.executedAt.toISOString();
  }
  return bundle;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function pickFirstOutputKey(spec: CanonicalWorkflowSpec): string | null {
  const keys = Object.keys(spec.outputs);
  return keys.length > 0 ? keys[0]! : null;
}
