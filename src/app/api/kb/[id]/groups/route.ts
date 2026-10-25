import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadEditableCollection } from "@/lib/kb/access";
import { createGroup } from "@/lib/kb/service";
import { labelSchema, requiredDescriptionSchema } from "@/lib/kb/validation";

const ROUTE = "/api/kb/[id]/groups";

// POST /api/kb/[id]/groups
// `parentId` nests a level-2 group under a level-1 one; anything deeper is
// refused by the service (and stated in the UI rather than silently enforced).

const createSchema = z
  .object({
    name: labelSchema,
    description: requiredDescriptionSchema,
    parentId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, createSchema);
    const collection = await loadEditableCollection(params.id, session);
    const row = await createGroup(collection.id, {
      name: body.name,
      description: body.description,
      parentId: body.parentId,
    });
    return NextResponse.json(row, { status: 201 });
  },
);
