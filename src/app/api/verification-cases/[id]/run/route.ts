import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { loadVisibleCase } from "@/lib/verification/access";
import { runMcpCase } from "@/lib/verification/runner-mcp";
import type { AssertionSpec } from "@/lib/verification/types";

const ROUTE = "/api/verification-cases/[id]/run";

const idSchema = z.coerce.number().int().positive();

// POST /api/verification-cases/[id]/run
// Synchronous one-shot execution of a single case. The result is
// returned inline; NOTHING is persisted (no verification_run /
// verification_case_result rows). Mirrors the playground behaviour
// of the existing MCP-management test page.

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ params, session }) => {
    const idParse = idSchema.safeParse(params.id);
    if (!idParse.success) {
      throw new ApiError("NOT_FOUND", 404, "Verification case not found.");
    }
    const caseId = idParse.data;
    const { caseRow, suite } = await loadVisibleCase(caseId, session);

    if (suite.category === "workflow") {
      throw new ApiError(
        "NOT_IMPLEMENTED",
        501,
        "Workflow verification cases are coming in a later release.",
        { code: "WORKFLOW_TESTS_V2" },
      );
    }
    if (!suite.mcpServerId || !caseRow.toolName) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Case is missing its MCP target (mcpServerId / toolName).",
      );
    }

    const outcome = await runMcpCase({
      mcpServerId: suite.mcpServerId,
      toolName: caseRow.toolName,
      input: (caseRow.input ?? {}) as Record<string, unknown>,
      assertions: (caseRow.assertions ?? []) as readonly AssertionSpec[],
    });

    return NextResponse.json(outcome);
  },
);
