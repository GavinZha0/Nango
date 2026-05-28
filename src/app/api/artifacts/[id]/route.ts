import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getArtifactBundle } from "@/lib/artifacts/get-artifact";
import { deleteNode } from "@/lib/artifacts/service";
import { updateArtifact } from "@/lib/artifacts/update-artifact";
import { withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";

/**
 * GET / PATCH / DELETE /api/artifacts/[id] — per-node operations on
 * the caller's artifact tree. Ownership is enforced inside the
 * service layer; missing rows surface as 404.
 *
 * PATCH supports rename / reparent / reorder / visibility flip on
 * both folders and leaves. Top-level seed categories are rejected.
 *
 * DELETE refuses to remove a seed category and refuses to remove a
 * non-empty folder. Clients are expected to clear children first.
 *
 * @see docs/artifact-dashboard-migration.md §4
 */

const ROUTE = "/api/artifacts/[id]";

const patchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    parentId: z.string().uuid().optional(),
    displayOrder: z.number().int().nonnegative().optional(),
    visibility: z.enum(["private", "shared"]).optional(),
    /**
     * Display config (chart type / colors / inline html / etc.).
     * Schema is artifact-type-specific; the route layer accepts
     * any JSON value and lets the artifact-page renderer enforce
     * type-specific shape. Per D31 / V1, workflow changes do NOT
     * go through this field — they go through chat
     * (modify_workflow defineTool).
     */
    content: z.unknown().optional(),
  })
  .strict();

/**
 * GET returns a render-ready artifact bundle:
 *   - `node`: the artifact entity (existing shape; backward compatible)
 *   - `workflow?`: present when the artifact is backed by a workflow
 *     (D8 1:N relation) — id + name + canonical spec + outputField
 *   - `data?` / `fromCache?` / `executedAt?`: present when workflow
 *     execution produced data for the page to render. W1.6.2 ships
 *     with a stubbed executor (always null); W1.6.x wires the real
 *     tool registry + runner adapter — see `get-artifact.ts`.
 *
 * Folders and standalone artifacts (no workflow) get `{ node }`
 * only — same as the pre-W1.6 shape.
 */
export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const bundle = await getArtifactBundle(params.id, session.user.id);
    return NextResponse.json(bundle);
  },
);

/**
 * PATCH updates artifact metadata (name, description, parent,
 * order, visibility) and/or display config (`content`). Returns
 * the same bundle shape as GET so frontend state-update code is
 * uniform across reads + writes.
 *
 * Workflow changes (filters, SQL edits, etc.) do NOT go through
 * PATCH — they go through chat (`modify_workflow` defineTool). See
 * D31 + the V1 form-mediated-rejection discussion.
 */
export const PATCH = withSession<{ id: string }>(
  ROUTE,
  async ({ req, params, session, log }) => {
    const patch = await parseBody(req, patchSchema);
    const bundle = await updateArtifact(params.id, patch, session.user.id);
    log.info(
      {
        event: "artifact_update",
        artifactId: bundle.node.id,
        keys: Object.keys(patch),
      },
      "artifact updated",
    );
    return NextResponse.json(bundle);
  },
);

export const DELETE = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session, log }) => {
    await deleteNode(params.id, session.user.id);
    log.info(
      { event: "artifact_delete", artifactId: params.id },
      "artifact deleted",
    );
    return NextResponse.json({ ok: true });
  },
);
