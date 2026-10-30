/**
 * GET / PATCH / DELETE one knowledge page, or a whole folder.
 *
 * Folders are implicit path prefixes, so the only difference between the two is
 * the scope of the write: `?kind=folder` rewrites or deletes every page under
 * the prefix. There is no folder row to keep in sync.
 *
 * @see docs/kb.md
 */

import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor, withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadEditableCollection, loadVisibleCollection } from "@/lib/kb/access";
import {
  deleteFolder,
  deletePage,
  getPage,
  renameFolder,
  updatePage,
  type UpdatePageInput,
} from "@/lib/kb/service";
import {
  contentTypeSchema,
  folderPathSchema,
  optionalDescriptionSchema,
  pagePathSchema,
  sourceRefSchema,
} from "@/lib/kb/validation";

const ROUTE = "/api/kb/[id]/pages/[...path]";

/**
 * The catch-all arrives as already-decoded segments. Joining them with `/`
 * rebuilds the stored path; a page name that contains a slash is illegal, so
 * there is exactly one path per URL.
 */
function pathFrom(params: { path?: string[] }): string {
  return (params.path ?? []).join("/");
}

function requestedKind(req: Request): "page" | "folder" {
  return new URL(req.url).searchParams.get("kind") === "folder"
    ? "folder"
    : "page";
}

// GET /api/kb/[id]/pages/[...path]
// The only human-facing read that returns `content`. The collection read ships
// summaries so a collection with 50 pages stays a small response.

export const GET = withSession<{ id: string; path: string[] }>(
  ROUTE,
  async ({ params, session }) => {
    const collection = await loadVisibleCollection(params.id, session);
    const path = pathFrom(params);
    if (path === "") {
      throw new ApiError("BAD_REQUEST", 400, "Missing page path.");
    }
    const page = await getPage(collection.id, path);
    return NextResponse.json(page);
  },
);

// PATCH /api/kb/[id]/pages/[...path]?kind=page
// `newPath` renames and moves in one field — a folder change is just a
// different prefix — while `sourceRef` stays provenance for the maintainer and
// never reaches an agent.

const updatePageSchema = z
  .object({
    newPath: pagePathSchema.optional(),
    description: optionalDescriptionSchema,
    content: z.string().min(1, "content must not be empty").optional(),
    contentType: contentTypeSchema.optional(),
    sourceRef: sourceRefSchema,
  })
  .strict();

// PATCH /api/kb/[id]/pages/[...path]?kind=folder
// `newPath` may nest the folder deeper or lift it out, as long as every
// rewritten page path stays legal.

const updateFolderSchema = z
  .object({ newPath: folderPathSchema })
  .strict();

export const PATCH = withEditor<{ id: string; path: string[] }>(
  ROUTE,
  async ({ req, params, session }) => {
    const collection = await loadEditableCollection(params.id, session);
    const scope = pathFrom(params);
    if (scope === "") {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Missing page or folder path.",
      );
    }
    const kind = requestedKind(req);

    if (kind === "folder") {
      const body = await parseBody(req, updateFolderSchema);
      const rewritten = await renameFolder(
        collection.id,
        scope,
        body.newPath,
        session.user.id,
      );
      return NextResponse.json({ ok: true, rewritten });
    }

    const body = await parseBody(req, updatePageSchema);
    const patch: UpdatePageInput = {};
    if (body.newPath !== undefined) patch.path = body.newPath;
    if (body.description !== undefined) patch.description = body.description;
    if (body.content !== undefined) patch.content = body.content;
    if (body.contentType !== undefined) patch.contentType = body.contentType;
    if (body.sourceRef !== undefined) patch.sourceRef = body.sourceRef;

    const row = await updatePage(collection.id, scope, patch, session.user.id);
    return NextResponse.json(row);
  },
);

// DELETE /api/kb/[id]/pages/[...path]?kind=page|folder
// A folder delete takes its whole subtree: a directory is only ever a name its
// pages share, so there is nothing left to orphan.

export const DELETE = withEditor<{ id: string; path: string[] }>(
  ROUTE,
  async ({ req, params, session }) => {
    const collection = await loadEditableCollection(params.id, session);
    const scope = pathFrom(params);
    if (scope === "") {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Missing page or folder path.",
      );
    }

    if (requestedKind(req) === "folder") {
      await deleteFolder(collection.id, scope);
    } else {
      await deletePage(collection.id, scope);
    }
    return new NextResponse(null, { status: 204 });
  },
);
