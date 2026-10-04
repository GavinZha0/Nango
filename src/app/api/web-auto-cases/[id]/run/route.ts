import "server-only";

import { NextResponse } from "next/server";

import { canEditResource, ResourceWithRBAC } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { WebAutoCaseTable, WebAutoSuiteTable } from "@/lib/db/schema";
import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { runWebAutoCase } from "@/lib/web-auto/orchestrator";
import { eq } from "drizzle-orm";

const ROUTE = "/api/web-auto-cases/[id]/run";

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const { id } = await params;
    const caseId = Number(id);
    if (!Number.isSafeInteger(caseId) || caseId <= 0) {
      throw new ApiError("VALIDATION_FAILED", 400, "Invalid case ID format.");
    }

    // Load case and parent suite
    const [caseRow] = await db
      .select()
      .from(WebAutoCaseTable)
      .where(eq(WebAutoCaseTable.id, caseId));

    if (!caseRow) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto case not found.");
    }

    const [suite] = await db
      .select()
      .from(WebAutoSuiteTable)
      .where(eq(WebAutoSuiteTable.id, caseRow.suiteId));

    if (!suite) {
      throw new ApiError("NOT_FOUND", 404, "Web Auto suite not found.");
    }

    if (!canEditResource(suite as unknown as ResourceWithRBAC, session)) {
      throw new ApiError(
        "FORBIDDEN",
        403,
        "You do not have permission to run cases in this suite.",
      );
    }

    if (!suite.mcpServerId) {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Suite does not have a Playwright MCP server configured.",
      );
    }

    const rawInput = (caseRow.input ?? {}) as Record<string, unknown>;
    if (!rawInput.script || typeof rawInput.script !== "string") {
      throw new ApiError(
        "BAD_REQUEST",
        400,
        "Case has no script content to execute.",
      );
    }

    const url = new URL(req.url);
    const wantsStream =
      req.headers.get("accept")?.includes("application/x-ndjson") ||
      url.searchParams.get("stream") === "true";

    const caseInput = {
      caseId: caseRow.id,
      suiteId: suite.id,
      suite,
      case: caseRow,
      ownerId: session.user.id,
    };

    if (wantsStream) {
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      const encoder = new TextEncoder();

      void (async () => {
        try {
          const outcome = await runWebAutoCase({
            ...caseInput,
            onExecutionComplete: async (execData) => {
              const frame =
                JSON.stringify({ type: "execution_complete", ...execData }) + "\n";
              await writer.write(encoder.encode(frame));
            },
          });
          const frame =
            JSON.stringify({ type: "verdict_complete", outcome }) + "\n";
          await writer.write(encoder.encode(frame));
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          const frame =
            JSON.stringify({ type: "error", error: errMessage }) + "\n";
          await writer.write(encoder.encode(frame));
        } finally {
          await writer.close();
        }
      })();

      return new Response(stream.readable, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const outcome = await runWebAutoCase(caseInput);

    return NextResponse.json(outcome);
  },
);
