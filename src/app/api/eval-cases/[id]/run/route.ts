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
import { NDJSON_CONTENT_TYPE, ndjsonResponse, wantsNdjson } from "@/lib/http/ndjson.server";
import { loadCase } from "@/lib/evaluation/access";
import { runEvalCase } from "@/lib/evaluation/eval-runner";
import { resolveSuiteVariables } from "@/lib/testing/variable-resolver.server";
import { sanitizeAssertions, type AssertionSpec } from "@/lib/assertions/types";
import type { EvalTurn } from "@/lib/evaluation/types";

export const maxDuration = 300;

const ROUTE = "/api/eval-cases/[id]/run";

const idSchema = z.coerce.number().int().positive();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
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

    const wantsStream = wantsNdjson(req);

    const { literalVariables, error: resolveError } = await resolveSuiteVariables(
      suite.variables,
      { allowCredentials: false },
    );

    if (resolveError) {
      if (wantsStream) {
        return new Response(
          JSON.stringify({
            type: "verdict_complete",
            outcome: {
              status: "errored",
              score: null,
              error: resolveError.message,
              feedback: resolveError.message,
            },
          }) + "\n",
          {
            headers: { "Content-Type": NDJSON_CONTENT_TYPE },
          },
        );
      }
      return NextResponse.json({
        status: "errored",
        score: null,
        error: resolveError.message,
        feedback: resolveError.message,
      });
    }

    const caseInput = (caseRow.input ?? {}) as Record<string, unknown>;
    const turns = (Array.isArray(caseInput.turns) ? caseInput.turns : []) as EvalTurn[];
    const assertions = sanitizeAssertions((Array.isArray(caseRow.assertions) ? caseRow.assertions : []) as AssertionSpec[]);

    const evalInput = {
      caseId: caseRow.id,
      targetAgentId: suite.agentId,
      targetCredentialId: suite.credentialId ?? undefined,
      agentSource: suite.agentSource === "builtin" ? ("builtin" as const) : ("backend" as const),
      evaluatorAgentId: suite.evaluatorAgentId ?? null,
      dimensionIds: [],
      threshold: suite.threshold ?? 3,
      caseTimeoutSec: suite.caseTimeoutSec,
      turns,
      assertions,
      ownerId: session.user.id,
      variables: literalVariables,
    };

    if (wantsStream) {
      return ndjsonResponse(req, (emit, signal) =>
        runEvalCase({
          ...evalInput,
          signal,
          onTargetComplete: (targetData) => emit({ type: "target_complete", ...targetData }),
        }),
      );
    }

    const outcome = await runEvalCase(evalInput);
    return NextResponse.json(outcome);
  },
);
