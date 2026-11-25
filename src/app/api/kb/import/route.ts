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
 * into: the importer has not read the corpus yet. A first import lands disabled
 * with a NULL description and the author publishes it from the panel once they
 * know what it is — see the `enabled ⇒ description` contract in
 * `src/lib/kb/service.ts`.
 *
 * The whole folder becomes one collection. A name collision — the slug is
 * globally unique because agents route by it — is negotiated, not just refused:
 * the first attempt answers 409 with enough detail for the panel to offer a
 * choice, and a retry carries `conflictStrategy`. `overwrite` replaces the
 * existing collection's corpus while keeping its id, bindings, description and
 * publish state, and is gated like a delete (owner or admin). `rename` imports
 * under `customName`, or under a server-allocated suffixed slug when none is
 * given. There is still no "add these files to collection X" partial merge: a
 * corpus is replaced whole or created new.
 *
 * See docs/kb.md.
 */

import "server-only";

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { BuiltinAgentToolTable, KbCollectionTable } from "@/lib/db/schema";
import { ApiError, withEditor, type Session } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { canDeleteResource } from "@/lib/auth/permissions";
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
import {
  importCollection,
  overwriteCollection,
  type ImportPageInput,
} from "@/lib/kb/service";
import { buildSuffixedKbName, collectionNameSchema } from "@/lib/kb/validation";

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
    conflictStrategy: z
      .enum(["fail", "overwrite", "rename"])
      .optional()
      .default("fail"),
    customName: collectionNameSchema.optional(),
  })
  .strict();

function randomDigits(len: number): string {
  const min = 10 ** (len - 1);
  const span = 9 * min;
  return String(min + Math.floor(Math.random() * span));
}

interface CollectionByName {
  id: string;
  name: string;
  enabled: boolean;
  visibility: "private" | "public";
  createdBy: string | null;
}

async function findCollectionByName(
  name: string,
): Promise<CollectionByName | null> {
  const rows = await db
    .select({
      id: KbCollectionTable.id,
      name: KbCollectionTable.name,
      enabled: KbCollectionTable.enabled,
      visibility: KbCollectionTable.visibility,
      createdBy: KbCollectionTable.createdBy,
    })
    .from(KbCollectionTable)
    .where(eq(KbCollectionTable.name, name))
    .limit(1);
  const row = rows[0];
  return row
    ? { ...row, visibility: row.visibility as "private" | "public" }
    : null;
}

/** How many agents would feel a corpus swap on this collection. */
async function countBoundAgents(collectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(BuiltinAgentToolTable)
    .where(eq(BuiltinAgentToolTable.kbCollectionId, collectionId));
  return row?.count ?? 0;
}

/**
 * The 409 the panel's conflict dialog is built from. `canOverwrite` is the
 * delete gate — a full corpus replacement is destructive enough that editing a
 * public collection must not imply it.
 */
async function throwNameConflict(
  existing: CollectionByName,
  session: Session,
): Promise<never> {
  throw new ApiError(
    "CONFLICT",
    409,
    `A knowledge base named "${existing.name}" already exists.`,
    {
      existingId: existing.id,
      existingName: existing.name,
      canOverwrite: canDeleteResource(existing, session),
      enabled: existing.enabled,
      boundAgentCount: await countBoundAgents(existing.id),
    },
  );
}

async function allocateSuffixedName(base: string): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const suffix = `_${randomDigits(attempt < 8 ? 3 : 5)}`;
    const candidate = buildSuffixedKbName(base, suffix);
    if (!(await findCollectionByName(candidate))) {
      return candidate;
    }
  }
  throw new ApiError(
    "CONFLICT",
    409,
    `Could not allocate a unique name for "${base}".`,
  );
}

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

  // Name-collision negotiation. A rename with a custom target looks that name
  // up; every other strategy is a collision on the submitted one.
  const strategy = body.conflictStrategy;
  const lookupName =
    strategy === "rename" && body.customName ? body.customName : body.name;
  const existing = await findCollectionByName(lookupName);

  let targetName = lookupName;
  if (existing) {
    if (strategy === "overwrite") {
      if (!canDeleteResource(existing, session)) {
        throw new ApiError(
          "FORBIDDEN",
          403,
          `"${existing.name}" belongs to another user; only its owner or an admin can overwrite it.`,
        );
      }
      const collection = await overwriteCollection({
        collectionId: existing.id,
        pages,
        updatedBy: session.user.id,
      });
      return NextResponse.json(
        { ...collection, pagesImported: pages.length, skipped, overwritten: true },
        { status: 200 },
      );
    }
    if (strategy === "rename" && !body.customName) {
      targetName = await allocateSuffixedName(body.name);
    } else {
      // "fail", or a rename onto a custom name that is itself taken — the
      // dialog stays open and the author picks another.
      await throwNameConflict(existing, session);
    }
  }
  // `existing === null` with strategy "overwrite" means the collection was
  // deleted between the dialog and the retry: fall through to a fresh import.

  const collection = await importCollection({
    name: targetName,
    createdBy: session.user.id,
    pages,
  });

  return NextResponse.json(
    { ...collection, pagesImported: pages.length, skipped },
    { status: 201 },
  );
});
