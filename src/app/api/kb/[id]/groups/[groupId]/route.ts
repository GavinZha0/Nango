import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadEditableCollection, requireRowId } from "@/lib/kb/access";
import { deleteGroup, updateGroup, type UpdateGroupInput } from "@/lib/kb/service";
import { labelSchema, requiredDescriptionSchema } from "@/lib/kb/validation";

const ROUTE = "/api/kb/[id]/groups/[groupId]";

// PATCH /api/kb/[id]/groups/[groupId]
// Rename, re-describe, or move. A rename is one row update — no descendant
// rewrite, which is what the group table buys over path prefixes.

const updateSchema = z
  .object({
    name: labelSchema.optional(),
    description: requiredDescriptionSchema.optional(),
    parentId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const PATCH = withEditor<{ id: string; groupId: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const collection = await loadEditableCollection(params.id, session);
    const groupId = requireRowId(params.groupId, "group");

    const patch: UpdateGroupInput = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.parentId !== undefined) patch.parentId = body.parentId;

    const row = await updateGroup(collection.id, groupId, patch);
    return NextResponse.json(row);
  },
);

// DELETE /api/kb/[id]/groups/[groupId]
// Deletes the group and every page under it. Refused with 409
// GROUP_HAS_CHILDREN while it still has nested groups — silently promoting
// them would rewrite the author's tree.

export const DELETE = withEditor<{ id: string; groupId: string }>(
  ROUTE,
  async ({ params, session }) => {
    const collection = await loadEditableCollection(params.id, session);
    const groupId = requireRowId(params.groupId, "group");
    await deleteGroup(collection.id, groupId);
    return new NextResponse(null, { status: 204 });
  },
);
