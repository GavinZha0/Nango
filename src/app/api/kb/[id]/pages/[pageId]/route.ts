import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadEditableCollection, loadVisibleCollection, requireRowId } from "@/lib/kb/access";
import { deletePage, getPage, updatePage, type UpdatePageInput } from "@/lib/kb/service";
import {
  contentTypeSchema,
  labelSchema,
  optionalDescriptionSchema,
  sourceRefSchema,
} from "@/lib/kb/validation";

const ROUTE = "/api/kb/[id]/pages/[pageId]";

// GET /api/kb/[id]/pages/[pageId]
// The only human-facing read that returns `content`. The tree endpoint ships
// summaries so a collection with 50 pages stays a small response.

export const GET = withSession<{ id: string; pageId: string }>(
  ROUTE,
  async ({ params, session }) => {
    const collection = await loadVisibleCollection(params.id, session);
    const page = await getPage(collection.id, requireRowId(params.pageId, "page"));
    return NextResponse.json(page);
  },
);

// PATCH /api/kb/[id]/pages/[pageId]
// `groupId` moves the page between groups; `source_ref` is provenance for the
// maintainer and never reaches an agent.

const updateSchema = z
  .object({
    name: labelSchema.optional(),
    description: optionalDescriptionSchema,
    groupId: z.number().int().positive().nullable().optional(),
    content: z.string().min(1, "content must not be empty").optional(),
    contentType: contentTypeSchema.optional(),
    sourceRef: sourceRefSchema,
  })
  .strict();

export const PATCH = withEditor<{ id: string; pageId: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, updateSchema);
    const collection = await loadEditableCollection(params.id, session);
    const pageId = requireRowId(params.pageId, "page");

    const patch: UpdatePageInput = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.groupId !== undefined) patch.groupId = body.groupId;
    if (body.content !== undefined) patch.content = body.content;
    if (body.contentType !== undefined) patch.contentType = body.contentType;
    if (body.sourceRef !== undefined) patch.sourceRef = body.sourceRef;

    const row = await updatePage(collection.id, pageId, patch, session.user.id);
    return NextResponse.json(row);
  },
);

// DELETE /api/kb/[id]/pages/[pageId]

export const DELETE = withEditor<{ id: string; pageId: string }>(
  ROUTE,
  async ({ params, session }) => {
    const collection = await loadEditableCollection(params.id, session);
    await deletePage(collection.id, requireRowId(params.pageId, "page"));
    return new NextResponse(null, { status: 204 });
  },
);
