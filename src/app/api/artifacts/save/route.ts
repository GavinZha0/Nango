import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  productionSaveDeps,
  saveArtifact,
} from "@/lib/artifacts/save-artifact";
import { withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";

/**
 * POST /api/artifacts/save — save an artifact from a chat
 * outcome.
 *
 * This is the canonical "Save" button on the outcomes-page card.
 * One round-trip: server reads the source `entity_run` events,
 * extracts a workflow via the W1.5 pure pipeline, and writes
 * artifact + workflow + lineage event in a single DB transaction
 * (`save-artifact.ts`).
 *
 * Per D31, the endpoint is artifact-shaped — the user sees "save
 * artifact"; the workflow concept stays implementation-internal.
 * The response carries `workflowId` for advanced UIs (data
 * lineage panel, admin tools) but the typical artifact-page
 * client only needs `artifactId`.
 *
 * Idempotent: re-clicking Save on the same outcome returns the
 * existing ids with `reused: true`.
 *
 * @see docs/workflow-architecture.md §10.1
 */
const ROUTE = "/api/artifacts/save";

const bodySchema = z
  .object({
    /** Chat thread the outcome belongs to. */
    threadId: z.string().uuid(),
    /** The frontend-side `Outcome.outcomeId` of the card the user
     *  clicked Save on. For `render_chart` outcomes this is the
     *  LLM-supplied `chartId`; for other tools it is the
     *  producer-chosen stable id (today: `toolCallId` for
     *  `web_search`). The server resolves this id to a concrete
     *  `(runId, toolCallId)` by scanning the thread's
     *  `tool_call_chunk` events. */
    outcomeId: z.string().min(1),
    /** Optional explicit folder. Default: user's seed category
     *  for the artifact's type. */
    parentId: z.string().uuid().optional(),
    /** Optional name override from the SaveOutcomeDialog. */
    name: z.string().min(1).max(200).optional(),
    /** Optional description (`null` clears it; omitted leaves DB
     *  default which is NULL). */
    description: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const POST = withSession(ROUTE, async ({ req, session, log }) => {
  const body = await parseBody(req, bodySchema);
  const result = await saveArtifact(
    {
      ownerId: session.user.id,
      threadId: body.threadId,
      outcomeId: body.outcomeId,
      ...(body.parentId !== undefined && { parentId: body.parentId }),
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
    },
    productionSaveDeps,
  );
  log.info(
    {
      event: "artifact_save_from_outcome",
      artifactId: result.artifactId,
      workflowId: result.workflowId,
      workflowOutputField: result.workflowOutputField,
      reused: result.reused,
      threadId: body.threadId,
      outcomeId: body.outcomeId,
    },
    result.reused
      ? "artifact save idempotent — existing row reused"
      : "artifact + workflow created from chat outcome",
  );
  return NextResponse.json(result);
});
