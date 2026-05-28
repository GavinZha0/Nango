/**
 * POST /api/artifacts/[id]/refresh handler core. Re-runs the
 * artifact's backing workflow (bypassing the L2 cache) and returns
 * a render-ready bundle matching GET's shape.
 *
 * Per D31 + the user-mental-model design:
 *   - User clicks the "Refresh" button on the artifact page
 *   - One round trip: bust L2 cache → re-execute → return bundle
 *     with `data` + `fromCache: false` + fresh `executedAt`
 *   - Response shape is the SAME as GET (consistent frontend
 *     state-update semantics)
 *
 * Implementation note: refresh shares all wiring with GET except
 * the `forceFresh: true` flag passed via `BundleOptions`. The
 * stub executor (W1.6.2) currently ignores `forceFresh` and
 * returns null regardless — refresh is functionally a no-op until
 * W1.6.x lands the real executor. We ship the endpoint anyway so
 * the contract is stable + the UI can wire the Refresh button now.
 */

import "server-only";

import { buildArtifactBundle, type ArtifactBundle } from "./bundle";
import { productionDeps } from "./get-artifact";

/**
 * Bust the L2 workflow-output cache for the artifact, re-execute
 * the workflow, return the refreshed bundle. Folders + standalone
 * artifacts (no workflow) round-trip with no data field — same
 * shape as GET on the same id.
 */
export async function refreshArtifact(
  artifactId: string,
  ownerId: string,
): Promise<ArtifactBundle> {
  return buildArtifactBundle(artifactId, ownerId, productionDeps, {
    forceFresh: true,
  });
}
