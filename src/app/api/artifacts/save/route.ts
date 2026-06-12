import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { saveArtifact } from "@/lib/artifacts/save-artifact";
import { buildProductionSaveDeps } from "@/lib/artifacts/save-deps.server";
import { withSession } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";

/**
 * POST /api/artifacts/save — Save button on the outcomes card.
 * Idempotent on (threadId, outcomeId) — re-saving returns existing
 * ids with `reused: true`. See docs/workflow-architecture.md.
 */
const ROUTE = "/api/artifacts/save";

const bodySchema = z
  .object({
    /** Chat thread the outcome belongs to. */
    threadId: z.string().uuid(),
    /** Producer-chosen `Outcome.outcomeId` — `chart_id` for
     *  `generate_echarts_config`, `toolCallId` for `web_search`. */
    outcomeId: z.string().min(1),
    /** Optional explicit folder. */
    parentId: z.string().uuid().optional(),
    name: z.string().min(1).max(200).optional(),
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
    buildProductionSaveDeps(session.user.id),
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
