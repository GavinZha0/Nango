/**
 * Render-ready artifact bundle assembler — shared by the four
 * artifact-write endpoints (save / get / update / refresh) per the
 * D31 + W1.6 design. One pure function that loads the artifact
 * row, optionally loads its backing workflow, optionally resolves
 * the workflow's data, and emits a consistent bundle shape.
 *
 * Why one shared assembler:
 *   - GET /api/artifacts/[id]      → bundle (open / view)
 *   - POST /api/artifacts/save     → bundle (newly saved)
 *   - PATCH /api/artifacts/[id]    → bundle (after edit)
 *   - POST /api/artifacts/[id]/refresh → bundle (cache-busted)
 *   All four return the SAME shape so frontend state management
 *   stays uniform: `setArtifact(response)` regardless of which
 *   endpoint fired.
 *
 * Dependency-injection-shaped — the DB loaders + workflow-execute
 * adapter are injected so tests can swap stubs. The route handler
 * wires the production deps (`get-artifact.ts`).
 *
 * Data resolution status (W1.6.2):
 *   - The bundle's `data` / `fromCache` / `executedAt` fields are
 *     populated only when `deps.executeWorkflow` returns a non-null
 *     `DataResolution`. The W1.6.2 default implementation returns
 *     null (no engine integration yet). W1.6.x adds the real tool
 *     registry + runner adapter wiring; until then the artifact
 *     page UI must tolerate `data === undefined` (show a
 *     "data not ready, click refresh" placeholder).
 */

import "server-only";

import { ApiError } from "@/lib/http/route-handlers";
import type { ArtifactEntity, WorkflowEntity } from "@/lib/db/schema";
import type { CanonicalWorkflowSpec } from "@/lib/workflows";

// ─── Public types ──────────────────────────────────────────────────────

export interface ArtifactBundle {
  /** Always present. Existing tree consumers expecting `{ node }`
   *  keep working — additive shape change. */
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
  /** Resolve the artifact's data via the workflow engine. Return
   *  null if execution wasn't attempted (e.g. W1.6.2 stub) or
   *  failed in a way the caller wants to surface as
   *  "data not available" rather than throw.
   *
   *  `forceFresh` (refresh path) bypasses the L2 workflow-output
   *  cache and forces a fresh execution. GET / save / update omit
   *  it; the refresh endpoint sets it to true. */
  executeWorkflow(args: {
    workflowId: string;
    spec: CanonicalWorkflowSpec;
    outputField: string;
    ownerId: string;
    forceFresh?: boolean;
    /** Human-readable label for forensic recording (D4a). Only the
     *  `forceFresh: true` path uses this; GET runs skip recording.
     *  Bundle.ts forwards `workflow.name` so the entity_run row
     *  surfaces "Refresh workflow: Q4 revenue chart" rather than
     *  the bare workflow id. */
    workflowName?: string;
  }): Promise<DataResolution | null>;
}

export interface BundleOptions {
  /** Pass-through to `deps.executeWorkflow.forceFresh`. The
   *  refresh endpoint sets this to true to bust the L2 cache. */
  forceFresh?: boolean;
}

// ─── Entry point ───────────────────────────────────────────────────────

/**
 * Build the render-ready bundle for one artifact. Throws `ApiError`
 * on not-found / access denied. Returns a bundle whose shape varies
 * by node kind:
 *
 *   - Folder (kind=folder)              → { node }
 *   - Standalone artifact (no workflow) → { node }
 *   - Workflow-backed artifact          → { node, workflow,
 *                                           [data, fromCache,
 *                                            executedAt] }
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
    // Defensive: artifact references a workflow that no longer
    // exists. The `ON DELETE SET NULL` FK would normally have
    // nulled workflowId, but a partial delete or a race could
    // leave a dangling reference. Surface as "no workflow" rather
    // than 500.
    return { node };
  }
  const spec = workflow.spec as CanonicalWorkflowSpec;
  const outputField = node.workflowOutputField ?? pickFirstOutputKey(spec);
  if (outputField === null) {
    // Workflow spec has no outputs — shouldn't happen post-save
    // (validate.ts requires non-empty outputs). Surface as
    // "no data" rather than crashing.
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
