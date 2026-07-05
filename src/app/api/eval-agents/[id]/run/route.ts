import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, withEditor } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { startEvalAgentAllRuns } from "@/lib/evaluation/run-orchestrator";

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

    // Trigger background serial suite testing
    await startEvalAgentAllRuns({
      agentId: parsedAgentId.data,
      agentSource: body.agentSource,
      credentialId: body.credentialId,
      ownerId: session.user.id,
      triggeredBy: "manual",
    });

    return new NextResponse(null, { status: 202 });
  },
);
