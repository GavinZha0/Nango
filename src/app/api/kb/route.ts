import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { listCollections, createCollection } from "@/lib/kb/service";
import { collectionNameSchema, optionalDescriptionSchema } from "@/lib/kb/validation";

const ROUTE = "/api/kb";

// GET /api/kb
// Collections visible to the session (own + public + all for admin), each with
// its folder and page counts. Newest first.

export const GET = withSession(ROUTE, async ({ session }) => {
  const collections = await listCollections(session);
  return NextResponse.json(collections);
});

// POST /api/kb
// A collection is an empty shell until its first page is added. The description
// is optional here because it is the routing line injected into every bound
// agent's prompt, and a brand-new shell has nothing to route to yet — the
// service refuses to *enable* a collection that has no prose.

const createSchema = z
  .object({
    name: collectionNameSchema,
    description: optionalDescriptionSchema,
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
