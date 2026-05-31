/**
 * PATCH /api/artifacts/[id] handler core. Wraps `service.updateNode`
 * (tree metadata + display `content`) and re-assembles the
 * render-ready bundle so the response matches GET / save / refresh.
 *
 * PATCH does NOT cover workflow changes — those go through a fresh
 * save from a new chat outcome. See docs/workflow.md.
 */

import "server-only";

import {
  buildArtifactBundle,
  type ArtifactBundle,
} from "./bundle";
import { getArtifactBundle } from "./get-artifact";
import { updateNode, type UpdateNodeInput } from "./service";

/**
 * Apply a partial update and return the render-ready bundle.
 *
 * Throws `ApiError(404)` when the artifact doesn't exist or isn't
 * owned by `ownerId` (propagated from `service.updateNode`).
 */
export async function updateArtifact(
  id: string,
  patch: UpdateNodeInput,
  ownerId: string,
): Promise<ArtifactBundle> {
  await updateNode(id, patch, ownerId);
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
  patch: UpdateNodeInput,
  ownerId: string,
  performUpdate: (
    id: string,
    patch: UpdateNodeInput,
    ownerId: string,
  ) => Promise<void>,
  bundleDeps: Parameters<typeof buildArtifactBundle>[2],
): Promise<ArtifactBundle> {
  await performUpdate(id, patch, ownerId);
  return buildArtifactBundle(id, ownerId, bundleDeps);
}
