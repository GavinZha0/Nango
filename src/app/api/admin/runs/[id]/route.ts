import "server-only";

import { NextResponse } from "next/server";
import { asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  BuiltinAgentTable,
  CredentialTable,
  EntityRunEventTable,
  EntityRunTable,
  UserTable,
} from "@/lib/db/schema";
import { ApiError, withAdmin } from "@/lib/http/route-handlers";

/**
 * GET /api/admin/runs/[id]
 */

const ROUTE = "/api/admin/runs/[id]";

export const GET = withAdmin<{ id: string }>(ROUTE, async ({ params }) => {
  const [run] = await db
    .select({
      id: EntityRunTable.id,
      parentRunId: EntityRunTable.parentRunId,
      threadId: EntityRunTable.threadId,
      initiator: EntityRunTable.initiator,
      entityId: EntityRunTable.entityId,
      entityKind: EntityRunTable.entityKind,
      entitySource: EntityRunTable.entitySource,
      credentialId: EntityRunTable.credentialId,
      builtinName: BuiltinAgentTable.name,
      credentialName: CredentialTable.name,
      mode: EntityRunTable.mode,
      status: EntityRunTable.status,
      inputTask: EntityRunTable.inputTask,
      inputContext: EntityRunTable.inputContext,
      inputParams: EntityRunTable.inputParams,
      outputSummary: EntityRunTable.outputSummary,
      outputArtifacts: EntityRunTable.outputArtifacts,
      errorMessage: EntityRunTable.errorMessage,
      errorDetails: EntityRunTable.errorDetails,
      ownerId: EntityRunTable.ownerId,
      ownerEmail: UserTable.email,
      ownerName: UserTable.name,
      startedAt: EntityRunTable.startedAt,
      finishedAt: EntityRunTable.finishedAt,
      deadline: EntityRunTable.deadline,
      createdAt: EntityRunTable.createdAt,
    })
    .from(EntityRunTable)
    .leftJoin(UserTable, eq(EntityRunTable.ownerId, UserTable.id))
    .leftJoin(
      BuiltinAgentTable,
      // text = uuid mismatch — coerce uuid → text (always valid).
      sql`${EntityRunTable.entityId} = ${BuiltinAgentTable.id}::text`,
    )
    .leftJoin(
      CredentialTable,
      eq(EntityRunTable.credentialId, CredentialTable.id),
    )
    .where(eq(EntityRunTable.id, params.id))
    .limit(1);

  if (!run) {
    throw new ApiError("NOT_FOUND", 404, "Run not found.");
  }

  const children = await db
    .select({
      id: EntityRunTable.id,
      parentRunId: EntityRunTable.parentRunId,
      initiator: EntityRunTable.initiator,
      entityId: EntityRunTable.entityId,
      entityKind: EntityRunTable.entityKind,
      entitySource: EntityRunTable.entitySource,
      builtinName: BuiltinAgentTable.name,
      credentialName: CredentialTable.name,
      mode: EntityRunTable.mode,
      status: EntityRunTable.status,
      inputTask: EntityRunTable.inputTask,
      errorMessage: EntityRunTable.errorMessage,
      startedAt: EntityRunTable.startedAt,
      finishedAt: EntityRunTable.finishedAt,
      createdAt: EntityRunTable.createdAt,
    })
    .from(EntityRunTable)
    .leftJoin(
      BuiltinAgentTable,
      sql`${EntityRunTable.entityId} = ${BuiltinAgentTable.id}::text`,
    )
    .leftJoin(
      CredentialTable,
      eq(EntityRunTable.credentialId, CredentialTable.id),
    )
    .where(eq(EntityRunTable.parentRunId, params.id))
    .orderBy(asc(EntityRunTable.createdAt));

  // Events: cap at a generous-but-bounded number to keep the
  // wire payload reasonable for chatty runs (large agno tool
  // chains can emit thousands of deltas). We pull the most recent
  // 1000 by `seq` and reverse client-side for display order.
  const events = await db
    .select()
    .from(EntityRunEventTable)
    .where(eq(EntityRunEventTable.runId, params.id))
    .orderBy(desc(EntityRunEventTable.seq))
    .limit(1000);

  return NextResponse.json({
    run,
    children,
    events: events.reverse(),
  });
});
