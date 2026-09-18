import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { canEditResource } from "@/lib/auth/permissions";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { loadVisibleSuite } from "@/lib/verification/access";
import {
  startSuiteRun,
  startGroupRun,
} from "@/lib/verification/run-orchestrator";

const ROUTE = "/api/verification-runs";

// POST /api/verification-runs
// Body: { suiteId } OR { groupId }
// Starts an ASYNC run (either single suite or group).
const startSchema = z
  .object({
    suiteId: z.string().uuid().optional(),
    groupId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (data) =>
      (data.suiteId && !data.groupId) || (!data.suiteId && data.groupId),
    { message: "Either suiteId or groupId must be provided, but not both." },
  );

export const POST = withEditor(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, startSchema);

  if (body.suiteId) {
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
      throw new ApiError("FORBIDDEN", 403, "You cannot run suite.");
    }

    if (!suite.enabled) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Verification suite is disabled.",
      );
    }

    // CONTRACT: suites detached from a deleted MCP server stay browsable
    // and editable but are never runnable.
    if (!suite.mcpServerId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Verification suite is detached from its MCP server (the server was deleted) and can no longer be run.",
      );
    }

    const { runId, totalCount } = await startSuiteRun({
      suiteId: suite.id,
      ownerId: session.user.id,
      triggeredBy: "manual",
    });
    return NextResponse.json({ runId, totalCount }, { status: 202 });
  } else {
    // Run all visible enabled suites in this Group
    const viewer = {
      userId: session.user.id,
      isAdmin: session.user.role === "admin",
      isEditor: true,
    };

    const result = await startGroupRun({
      groupId: body.groupId!,
      ownerId: session.user.id,
      viewer,
      triggeredBy: "manual",
    });

    return NextResponse.json(result, { status: 202 });
  }
});
