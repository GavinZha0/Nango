import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { startEvalAgentAllRuns } from "@/lib/evaluation/run-orchestrator";
import { isAgentVisibleTo } from "@/lib/access/agent-visibility";

const ROUTE = "/api/eval-agents/[id]/run";

const agentIdSchema = z.string().min(1).max(120);
const runBodySchema = z
  .object({
    agentSource: z.enum(["builtin", "backend"]),
    credentialId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const POST = withEditor<{ id: string }>(
  ROUTE,
  async ({ req, params, session }) => {
    const parsedAgentId = agentIdSchema.safeParse(params.id);
    if (!parsedAgentId.success) {
      throw new ApiError("BAD_REQUEST", 400, "Invalid agent ID.");
    }
    const body = await parseBody(req, runBodySchema);

    // SECURITY (BUG-3): a built-in agent must be visible to the caller.
    // 404 in both "missing" and "forbidden" cases so we don't leak the
    // existence of other users' private agents. Backend agents are
    // protected at the suite-visibility layer below.
    if (
      body.agentSource === "builtin" &&
      !(await isAgentVisibleTo(parsedAgentId.data, session.user.id))
    ) {
      throw new ApiError("NOT_FOUND", 404, "Agent not found.");
    }

    // Trigger background serial suite testing. Only suites visible to
    // the owner run (admin bypasses).
    await startEvalAgentAllRuns({
      agentId: parsedAgentId.data,
      agentSource: body.agentSource,
      credentialId: body.credentialId,
      ownerId: session.user.id,
      isAdmin: session.user.role === "admin",
      triggeredBy: "manual",
    });

    return new NextResponse(null, { status: 202 });
  },
);
