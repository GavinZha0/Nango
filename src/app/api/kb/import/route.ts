/**
 * POST /api/kb/import — import a folder of text files as one knowledge collection.
 *
 * Transport, path legality, noise handling and byte budgets come from
 * `@/lib/folder-import`; the knowledge-specific parts are the text-only
 * allowlist, the `content_type` hint, and the description each page gets from
 * its own first paragraph. Unlike a skill, a folder of notes carries no manifest
 * to read a name from, so `name` is the folder's own name, normalized to the
 * collection slug rule client-side.
 *
 * There is no collection `description` in this body and no dialog to type one
 * into: the importer has not read the corpus yet. The collection lands disabled
 * with a NULL description and the author publishes it from the panel once they
 * know what it is — see the `enabled ⇒ description` contract in
 * `src/lib/kb/service.ts`.
 *
 * The whole folder becomes one new collection — there is no "add these files to
 * collection X" path, because merging a foreign tree into a corpus an agent is
 * already reading is the one thing a reviewable import cannot promise.
 *
 * See docs/kb.md.
 */

import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { folderManifestSchema } from "@/lib/folder-import/manifest";
import {
  assertBodyWithinCap,
  assertNoBlocked,
  assertNoPathKindClash,
  walkEntries,
} from "@/lib/folder-import/preflight";
import { MAX_PAGES_PER_COLLECTION, PAGE_MAX_BYTES } from "@/lib/kb/budgets";
import { derivePageDescription } from "@/lib/kb/digest";
import {
  classifyKbImportPath,
  kbContentType,
  textDecodeProblem,
} from "@/lib/kb/import-policy";
import { pathProblem } from "@/lib/kb/paths";
import { importCollection, type ImportPageInput } from "@/lib/kb/service";
import { collectionNameSchema } from "@/lib/kb/validation";

const ROUTE = "/api/kb/import";

// Same request ceiling as a skill import: base64 is a fixed 4/3 factor over the
// 10 MB decoded cap, and the extra headroom has to still be enforced before
// `req.json()` buffers the body.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const importSchema = z
  .object({
    name: collectionNameSchema,
    entries: folderManifestSchema.shape.entries,
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  assertBodyWithinCap(req, MAX_REQUEST_BYTES);
  const body = await parseBody(req, importSchema);

  const { files, skipped, blocked } = walkEntries(body.entries, {
    caps: {
      // A collection is one folder, so the corpus budgets *are* the upload caps.
      maxFiles: MAX_PAGES_PER_COLLECTION(),
      maxFileBytes: PAGE_MAX_BYTES(),
      maxTotalBytes: MAX_TOTAL_BYTES,
    },
    admit: classifyKbImportPath,
    // The same segment rules the editor enforces: an over-deep or empty-segment
    // path from a foreign tree fails here, with the path in the report.
    validatePath: (path) => pathProblem(path),
    // The walker proves "no NUL"; this proves the bytes are UTF-8 at all.
    validateContent: (_path, content) => textDecodeProblem(content),
  });

  assertNoBlocked(blocked);
  assertNoPathKindClash(files);

  const pages: ImportPageInput[] = files.map((file) => {
    const content: string = file.content.toString("utf8");
    const contentType = kbContentType(file.path);
    return {
      path: file.path,
      content,
      contentType,
      description: derivePageDescription(content, contentType),
    };
  });

  const collection = await importCollection({
    name: body.name,
    createdBy: session.user.id,
    pages,
  });

  return NextResponse.json(
    { ...collection, pagesImported: pages.length, skipped },
    { status: 201 },
  );
});
