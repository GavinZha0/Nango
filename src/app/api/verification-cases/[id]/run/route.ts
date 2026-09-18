import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { canEditResource } from "@/lib/auth/permissions";
import { loadVisibleCase } from "@/lib/verification/access";
import { runMcpCase } from "@/lib/verification/runner-mcp";
import { resolveEffectiveToolName } from "@/lib/verification/tool-name";
import { resolveSuiteVariables } from "@/lib/testing/variable-resolver.server";
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

    if (
      !canEditResource(
        { visibility: suite.visibility as "private" | "public", createdBy: suite.createdBy },
        session,
      )
    ) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You cannot run cases in this verification suite.",
      );
    }

    if (!suite.mcpServerId || !caseRow.toolName) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Case is missing its MCP target (mcpServerId / toolName).",
      );
    }

    const { literalVariables, error: resolveError } = await resolveSuiteVariables(
      suite.variables,
      { allowCredentials: false },
    );

    if (resolveError) {
      return NextResponse.json({
        status: "errored",
        resolvedInput: (caseRow.input ?? {}) as Record<string, unknown>,
        resultPayload: null,
        resultTruncated: false,
        assertionResults: [],
        error: resolveError,
        startedAt: Date.now(),
        durationMs: 0,
      });
    }

    const effectiveToolName = resolveEffectiveToolName(
      caseRow.toolName,
      suite.toolPrefixRule,
    );

    const outcome = await runMcpCase(
      {
        mcpServerId: suite.mcpServerId,
        toolName: effectiveToolName,
        originalToolName: caseRow.toolName,
        serverName: suite.mcpServerName ?? undefined,
        rule: suite.toolPrefixRule ?? undefined,
        input: (caseRow.input ?? {}) as Record<string, unknown>,
        assertions: (caseRow.assertions ?? []) as readonly AssertionSpec[],
      },
      { variables: literalVariables },
    );

    return NextResponse.json({
      ...outcome,
      originalToolName: caseRow.toolName,
      effectiveToolName,
    });
  },
);
