/**
 * POST /api/eval-suites/[id]/run — start an async eval suite run.
 * Returns 202 + { runId, totalCount }. The actual execution runs
 * in the background; progress is streamed via SSE on /api/runs/stream.
 */

import "server-only";

import { NextResponse } from "next/server";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadSuite } from "@/lib/evaluation/access";
import { startEvalSuiteRun } from "@/lib/evaluation/run-orchestrator";

const ROUTE = "/api/eval-suites/[id]/run";

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const suite = await loadSuite(params.id, session);

    if (
      !canEditResource(
        { visibility: "private", createdBy: suite.createdBy },
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

    if (!suite.evaluatorAgentId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Evaluation suite has no evaluator agent assigned.",
      );
    }

    const { runId, totalCount } = await startEvalSuiteRun({
      suiteId: suite.id,
      ownerId: session.user.id,
      triggeredBy: "manual",
    });

    return NextResponse.json({ runId, totalCount }, { status: 202 });
  },
);
