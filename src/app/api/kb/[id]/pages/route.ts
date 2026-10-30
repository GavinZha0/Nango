import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadEditableCollection } from "@/lib/kb/access";
import { createPage } from "@/lib/kb/service";
import {
  contentTypeSchema,
  optionalDescriptionSchema,
  pagePathSchema,
  sourceRefSchema,
} from "@/lib/kb/validation";

const ROUTE = "/api/kb/[id]/pages";

// POST /api/kb/[id]/pages
// `path` carries the folder prefixes with it — a page three levels deep is one
// field, and the folders it implies exist as long as this row does. `content` is
// stored verbatim, deliberately not trimmed, because a CSV or YAML page whose
// leading bytes change is a different artifact. The byte ceiling
// (kb.page_max_bytes) is enforced by the service, not here, since the message
// has to quote both the measured size and the configured limit.

const createSchema = z
  .object({
    path: pagePathSchema,
    description: optionalDescriptionSchema,
    content: z.string().min(1, "content must not be empty"),
    contentType: contentTypeSchema.optional(),
    sourceRef: sourceRefSchema,
  })
  .strict();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const body = await parseBody(req, createSchema);
    const collection = await loadEditableCollection(params.id, session);
    const row = await createPage(
      collection.id,
      {
        path: body.path,
        description: body.description,
        content: body.content,
        contentType: body.contentType,
        sourceRef: body.sourceRef,
      },
      session.user.id,
    );
    return NextResponse.json(row, { status: 201 });
  },
);
