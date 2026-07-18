import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { db } from "@/lib/db";
import { EntityRunTable } from "@/lib/db/schema";
import { withSession, ApiError } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { recordEvent } from "@/lib/runner/event-store";
import { publish } from "@/lib/runner/event-bus";
import { RunSequenceRegistry } from "@/lib/runner/sequence-registry";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "runs-approvals-api" });

const ROUTE = "/api/runs/[runId]/approvals";

const approvalsSchema = z.object({
  approvalId: z.string().uuid(),
  approved: z.boolean(),
});

export const POST = withSession<{ runId: string }>(ROUTE, async ({ req, params, session }) => {
  const { runId } = params;
  const userId = session.user.id;
  const body = await parseBody(req, approvalsSchema);

  // 1. Verify that the run exists and belongs to the authenticated user
  const runs = await db
    .select()
    .from(EntityRunTable)
    .where(
      and(
        eq(EntityRunTable.id, runId),
        eq(EntityRunTable.ownerId, userId)
      )
    )
    .limit(1);

  const run = runs[0] ?? null;

  if (!run) {
    log.warn({ runId, userId }, "unauthorized or non-existent run approval attempt");
    throw new ApiError("NOT_FOUND", 404, "Run not found");
  }

  // 2. Persist approval result as a run event
  try {
    const seqNow = await RunSequenceRegistry.getAndIncrement(runId);
    const type = body.approved ? "tool_call_approved" : "tool_call_rejected";
    
    await recordEvent(runId, seqNow, type, {
      approvalId: body.approvalId,
      resolvedAt: new Date().toISOString()
    });
    log.info({ runId, approvalId: body.approvalId, approved: body.approved }, "persisted tool approval decision");
  } catch (e) {
    log.error({ runId, err: e }, "failed to record tool approval event");
    throw new ApiError("INTERNAL", 500, "Failed to record approval decision");
  }

  // 3. Publish resolution to EventBus to notify the suspended tool execution Promise
  publish(userId, {
    kind: "tool_approval_resolved",
    runId,
    approvalId: body.approvalId,
    approved: body.approved,
  });

  return NextResponse.json({ ok: true });
});
