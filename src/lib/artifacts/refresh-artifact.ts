/**
 * POST /api/artifacts/[id]/refresh handler core. Re-runs the
 * artifact's backing workflow with `forceFresh: true` and returns
 * a render-ready bundle in the same shape as GET. See
 * docs/workflow.md.
 */

import "server-only";

import { buildArtifactBundle, type ArtifactBundle } from "./bundle";
import { productionDeps } from "./get-artifact";

/**
 * Force-fresh re-execute of the artifact's workflow. Folders and
 * standalone artifacts (no workflow) round-trip with no `data`
 * field — same shape as GET on the same id.
 */
export async function refreshArtifact(
  artifactId: string,
  ownerId: string,
): Promise<ArtifactBundle> {
  return buildArtifactBundle(artifactId, ownerId, productionDeps, {
    forceFresh: true,
  });
}
