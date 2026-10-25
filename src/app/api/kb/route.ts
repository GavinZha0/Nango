import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { listCollections, createCollection } from "@/lib/kb/service";
import { collectionNameSchema, requiredDescriptionSchema } from "@/lib/kb/validation";

const ROUTE = "/api/kb";

// GET /api/kb
// Collections visible to the session (own + public + all for admin), each with
// its group and page counts. Newest first.

export const GET = withSession(ROUTE, async ({ session }) => {
  const collections = await listCollections(session);
  return NextResponse.json(collections);
});

// POST /api/kb
// A collection is an empty shell until a group or page is added; `description`
// is required because it is the level-1 routing signal injected into every
// bound agent's prompt.

const createSchema = z
  .object({
    name: collectionNameSchema,
    description: requiredDescriptionSchema,
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);
  const row = await createCollection({
    name: body.name,
    description: body.description,
    visibility: body.visibility,
    createdBy: session.user.id,
  });
  return NextResponse.json(row, { status: 201 });
});
