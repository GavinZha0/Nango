/**
 * POST /api/eval-cases/[id]/run — synchronous single-case eval playground run.
 * Runs target agent + evaluator agent synchronously inline and returns the result JSON;
 * NOTHING is persisted to eval_run or eval_case_result (mirrors Verification & Web Auto).
 */

import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadCase } from "@/lib/evaluation/access";
import { runEvalCase } from "@/lib/evaluation/eval-runner";
import type { EvalCriteria, EvalTurn } from "@/lib/evaluation/types";

export const maxDuration = 300;

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

    const outcome = await runEvalCase({
      caseId: caseRow.id,
      targetAgentId: suite.agentId,
      targetCredentialId: suite.credentialId ?? undefined,
      targetEntityKind: suite.agentSource === "builtin" ? undefined : "agent",
      evaluatorAgentId: suite.evaluatorAgentId,
      dimensionIds: (suite.dimensionIds ?? []) as string[],
      turns: (caseRow.turns ?? []) as EvalTurn[],
      criteria: (caseRow.criteria ?? {}) as EvalCriteria,
      ownerId: session.user.id,
    });

    return NextResponse.json(outcome);
  },
);
