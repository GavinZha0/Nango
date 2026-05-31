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
 * See docs/artifact-evolution.md.
 */

const ROUTE = "/api/artifacts/[id]";

const patchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    parentId: z.string().uuid().optional(),
    displayOrder: z.number().int().nonnegative().optional(),
    visibility: z.enum(["private", "shared"]).optional(),
    /** Display config (chart type / colors / inline html / etc.).
     *  Type-specific shape — the artifact-page renderer enforces
     *  it. Workflow changes do NOT go through this field. */
    content: z.unknown().optional(),
  })
  .strict();

/** Returns the render-ready bundle (see `lib/artifacts/bundle.ts`). */
export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const bundle = await getArtifactBundle(params.id, session.user.id);
    return NextResponse.json(bundle);
  },
);

/** PATCH updates metadata and/or display `content`. Returns the
 *  same bundle shape as GET. Does NOT cover workflow changes —
 *  those flow through a new save. */
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
