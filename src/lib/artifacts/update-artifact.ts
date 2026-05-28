/**
 * PATCH /api/artifacts/[id] handler core. Wraps `service.updateNode`
 * (tree-management + content field) and re-assembles the
 * render-ready bundle after the write so the response shape is
 * consistent with GET / POST /save / POST /refresh.
 *
 * Per D31 + the V1 design: PATCH covers
 *   - tree metadata (name, description, parentId, displayOrder,
 *     visibility) — existing behaviour from service.ts
 *   - display config (`content`) — chart type / colors / inline
 *     HTML / inline markdown
 *
 * PATCH does NOT cover workflow changes — those go through chat
 * (`modify_workflow` defineTool) per the V1 form-mediated rejection
 * (you / earlier discussion).
 */

import "server-only";

import {
  buildArtifactBundle,
  type ArtifactBundle,
} from "./bundle";
import { getArtifactBundle } from "./get-artifact";
import { updateNode, type UpdateNodeInput } from "./service";

/**
 * Apply a partial update + return the render-ready bundle. Same
 * response shape as GET — frontend `setArtifact(response)` works
 * uniformly across read / write paths.
 *
 * Throws `ApiError(404)` if the artifact doesn't exist or isn't
 * owned by `ownerId` (propagated from `service.updateNode`).
 */
export async function updateArtifact(
  id: string,
  patch: UpdateNodeInput,
  ownerId: string,
): Promise<ArtifactBundle> {
  // First apply the row-level update. Throws on access /
  // not-found / invalid patch (seed-category guard, cycle guard).
  await updateNode(id, patch, ownerId);

  // Then re-load the full bundle so the response matches GET.
  // We could `INSERT … RETURNING` and skip the second read, but
  // bundle assembly does its own workflow lookup + (eventually)
  // workflow execution — duplicating that logic here would be
  // brittle. One extra row-by-id select is acceptable.
  return getArtifactBundle(id, ownerId);
}

/**
 * Test-friendly variant — accepts the bundle deps directly so
 * tests don't need to mock `@/lib/db` indirectly through
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
