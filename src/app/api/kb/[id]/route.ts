import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canChangeVisibility } from "@/lib/auth/permissions";
import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import {
  loadEditableCollection,
  loadOwnedCollection,
  loadVisibleCollection,
} from "@/lib/kb/access";
import {
  deleteCollection,
  getPages,
  updateCollection,
  type UpdateCollectionInput,
} from "@/lib/kb/service";
import {
  collectionNameSchema,
  requiredDescriptionSchema,
} from "@/lib/kb/validation";

const ROUTE = "/api/kb/[id]";

// GET /api/kb/[id]
// The collection row plus every page summary (no page bodies), in the order the
// agent-facing index uses. There is no folder payload: the editor derives its
// tree from the page paths, so nothing in this response can disagree with them.

export const GET = withSession<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const collection = await loadVisibleCollection(params.id, session);
    const pages = await getPages(collection.id);
    return NextResponse.json({ ...collection, pages });
  },
);

// PATCH /api/kb/[id]
// Two gates, because the fields change different amounts of blast radius:
// content (including the slug) is editable by anyone who can edit, while
// `enabled` / `visibility` unmount the collection for other users.

const updateSchema = z
  .object({
    name: collectionNameSchema.optional(),
    description: requiredDescriptionSchema.optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const collection = await loadEditableCollection(params.id, session);
    const rbac = {
      visibility: collection.visibility as "private" | "public",
      createdBy: collection.createdBy,
    };

    const patch: UpdateCollectionInput = {};
    if (body.description !== undefined) patch.description = body.description;
    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) {
      if (!canChangeVisibility(rbac, session)) {
        throw new ApiError(
          "FORBIDDEN",
          403,
          "Only the author or an admin can enable or disable this knowledge collection.",
        );
      }
      patch.enabled = body.enabled;
    }
    if (body.visibility !== undefined) {
      if (!canChangeVisibility(rbac, session)) {
        throw new ApiError(
          "FORBIDDEN",
          403,
          "Only the author or an admin can change the visibility of this knowledge collection.",
        );
      }
      patch.visibility = body.visibility;
    }

    const row = await updateCollection(collection.id, patch, session.user.id);
    return NextResponse.json(row);
  },
);

// DELETE /api/kb/[id]
// Hard delete; the pages cascade and bound agents lose the mount block.

export const DELETE = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const collection = await loadOwnedCollection(params.id, session);
    await deleteCollection(collection.id);
    return new NextResponse(null, { status: 204 });
  },
);
