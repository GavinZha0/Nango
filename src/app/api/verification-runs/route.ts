import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadVisibleSuite } from "@/lib/verification/access";
import { startSuiteRun } from "@/lib/verification/run-orchestrator";

const ROUTE = "/api/verification-runs";

// POST /api/verification-runs
// Body: { suiteId }
// Starts an ASYNC suite run. Returns immediately with the new runId;
// case results stream via SSE on `/api/runs/stream` filtered by
// `topic: "verification_run"`. See docs/verification.md.

const startSchema = z
  .object({
    suiteId: z.string().uuid(),
  })
  .strict();

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, startSchema);
  const suite = await loadVisibleSuite(body.suiteId, session);

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
      "You cannot run this verification suite.",
    );
  }

  if (!suite.enabled) {
    throw new ApiError(
      "BAD_REQUEST",
      400,
      "Verification suite is disabled.",
    );
  }

  try {
    const { runId, totalCount } = await startSuiteRun({
      suiteId: suite.id,
      ownerId: session.user.id,
      triggeredBy: "manual",
    });
    return NextResponse.json({ runId, totalCount }, { status: 202 });
  } catch (err) {
    if (err instanceof Error && err.message === "WORKFLOW_TESTS_V2") {
      throw new ApiError(
        "NOT_IMPLEMENTED",
        501,
        "Workflow verification suites are coming in a later release.",
        { code: "WORKFLOW_TESTS_V2" },
      );
    }
    throw err;
  }
});
