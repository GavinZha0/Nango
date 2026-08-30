/**
 * POST /api/eval-runs — start an async evaluation run.
 *
 * Supports both:
 * 1. Single suite execution: `{ suiteId }`
 * 2. Full agent batch evaluation: `{ agentId, agentSource?, credentialId? }`
 *
 * Returns HTTP 202 Accepted.
 *
 * See docs/evaluation.md.
 */

import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadSuite } from "@/lib/evaluation/access";
import {
  startEvalSuiteRun,
  startEvalAgentAllRuns,
} from "@/lib/evaluation/run-orchestrator";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";

const ROUTE = "/api/eval-runs";

const startEvalRunSchema = z
  .object({
    suiteId: z.string().uuid().optional(),
    agentId: z.string().min(1).max(120).optional(),
    agentSource: z.enum(["builtin", "backend"]).default("builtin"),
    credentialId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (data) => (data.suiteId && !data.agentId) || (!data.suiteId && data.agentId),
    { message: "Either suiteId or agentId must be provided, but not both." },
  );

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, startEvalRunSchema);

  if (body.suiteId) {
    const suite = await loadSuite(body.suiteId, session);

    if (
      !canEditResource(
        {
          visibility: suite.visibility as "private" | "public",
          createdBy: suite.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot run this evaluation suite.",
      );
    }

    if (!suite.enabled) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Evaluation suite is disabled.",
      );
    }

    const { runId, totalCount } = await startEvalSuiteRun({
      suiteId: suite.id,
      ownerId: session.user.id,
      triggeredBy: "manual",
    });

    return NextResponse.json({ runId, totalCount }, { status: 202 });
  }

  // Agent-level batch evaluation
  const agentId = body.agentId!;

  // SECURITY: a built-in agent must be visible to the caller.
  if (
    body.agentSource === "builtin" &&
    !(await isAgentVisibleTo(agentId, session.user.id))
  ) {
    throw new ApiError("NOT_FOUND", 404, "Agent not found.");
  }

  await startEvalAgentAllRuns({
    agentId,
    agentSource: body.agentSource,
    credentialId: body.credentialId,
    ownerId: session.user.id,
    isAdmin: session.user.role === "admin",
    triggeredBy: "manual",
  });

  return NextResponse.json({ message: "Agent evaluation started." }, { status: 202 });
});
