/**
 * POST /api/eval-cases/[id]/run — start an async single-case eval run.
 * Creates an eval_run with totalCount=1 and runs the case in the
 * background. Returns 202 + { runId }. Progress via SSE.
 */

import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadCase } from "@/lib/evaluation/access";
import { startEvalSuiteRun } from "@/lib/evaluation/run-orchestrator";

const ROUTE = "/api/eval-cases/[id]/run";

const idSchema = z.coerce.number().int().positive();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const idParse = idSchema.safeParse(params.id);
    if (!idParse.success) {
      throw new ApiError("NOT_FOUND", 404, "Eval case not found.");
    }
    const caseId = idParse.data;
    const { caseRow, suite } = await loadCase(caseId, session);

    if (
      !canEditResource(
        { visibility: suite.visibility as "private" | "public", createdBy: suite.createdBy },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot run cases in this evaluation suite.",
      );
    }

    if (!suite.evaluatorAgentId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Suite has no evaluator agent assigned.",
      );
    }

    const { runId } = await startEvalSuiteRun({
      suiteId: suite.id,
      ownerId: session.user.id,
      triggeredBy: "manual",
      caseIds: [caseRow.id],
    });

    return NextResponse.json({ runId }, { status: 202 });
  },
);
