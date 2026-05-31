import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { createFolder } from "@/lib/artifacts/service";

/**
 * POST /api/artifacts — create a folder in the per-user artifact tree.
 *
 * Folder-only. The "create an artifact directly" branch was retired
 * with the parallel chart-save path; the canonical save flow is
 * `POST /api/artifacts/save`, which captures the source outcome's
 * tool chain into a workflow plus an artifact row in one DB
 * transaction.
 *
 * The `kind: "folder"` body shape is preserved for client compat
 * (`ArtifactPanel.tsx::postFolder` still sends it). The field
 * documents intent; there is no discriminated union to switch on
 * because only one kind is accepted.
 *
 * See docs/artifact-evolution.md and docs/workflow-architecture.md.
 */
const ROUTE = "/api/artifacts";

const createFolderBodySchema = z
  .object({
    kind: z.literal("folder"),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    /** Required — top-level (parent_id IS NULL) is system-seeded. */
    parentId: z.string().uuid(),
  })
  .strict();

export const POST = withSession(ROUTE, async ({ req, session, log }) => {
  const body = await parseBody(req, createFolderBodySchema);
  const row = await createFolder({
    ownerId: session.user.id,
    name: body.name,
    parentId: body.parentId,
    description: body.description ?? null,
  });
  log.info({ event: "artifact_folder_create", artifactId: row.id });
  return NextResponse.json({ id: row.id });
});
