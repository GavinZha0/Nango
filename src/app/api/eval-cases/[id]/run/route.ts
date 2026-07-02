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
import * as storage from "@/lib/evaluation/storage";
import { runEvalCase } from "@/lib/evaluation/eval-runner";
import { publish } from "@/lib/runner/event-bus";
import type { EvalCriteria, EvalTurn } from "@/lib/evaluation/types";

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
        { visibility: "private", createdBy: suite.createdBy },
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

    const run = await storage.createRun({
      suiteId: suite.id,
      totalCount: 1,
      triggeredBy: "manual",
    });

    const ownerId = session.user.id;

    publish(ownerId, {
      kind: "evaluation",
      ownerId,
      frame: {
        topic: "evaluation_run",
        kind: "run_started",
        runId: run.id,
        suiteId: suite.id,
        totalCount: 1,
      },
    });

    // Fire-and-forget single case execution.
    void (async () => {
      let status: "passed" | "failed" | "errored" = "errored";
      try {
        const result = await runEvalCase({
          runId: run.id,
          caseId: caseRow.id,
          targetAgentId: suite.agentId,
          targetCredentialId: suite.credentialId ?? undefined,
          targetEntityKind:
            suite.agentSource === "builtin" ? undefined : "agent",
          evaluatorAgentId: suite.evaluatorAgentId!,
          dimensionIds: (suite.dimensionIds ?? []) as string[],
          turns: (caseRow.turns ?? []) as EvalTurn[],
          criteria: (caseRow.criteria ?? {}) as EvalCriteria,
          ownerId,
        });
        status = result.status;

        publish(ownerId, {
          kind: "evaluation",
          ownerId,
          frame: {
            topic: "evaluation_run",
            kind: "case_completed",
            runId: run.id,
            caseId: caseRow.id,
            caseName: caseRow.name,
            status: result.status,
            score: result.score,
            dimensionScores: result.dimensionScores,
            criteriaScore: result.criteriaScore,
            criteriaResults: result.criteriaResults,
            feedback: result.feedback,
          },
        });
      } catch {
        // runEvalCase should never throw, but defend in depth.
      }

      const passed = status === "passed" ? 1 : 0;
      const failed = status === "failed" ? 1 : 0;
      const errored = status === "errored" ? 1 : 0;

      await storage.finalizeRun({
        runId: run.id,
        status,
        score: passed ? 100 : 0,
        passedCount: passed,
        failedCount: failed,
        erroredCount: errored,
      });

      publish(ownerId, {
        kind: "evaluation",
        ownerId,
        frame: {
          topic: "evaluation_run",
          kind: "run_finished",
          runId: run.id,
          status,
          totalCount: 1,
          passedCount: passed,
          failedCount: failed,
          erroredCount: errored,
        },
      });
    })();

    return NextResponse.json({ runId: run.id }, { status: 202 });
  },
);
