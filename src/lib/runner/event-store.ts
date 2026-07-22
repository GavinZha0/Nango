/**
 * Persistence layer for `entity_run` + `entity_run_event`.
 *
 * See docs/runner-events.md.
 */

import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  EntityRunEventTable,
  EntityRunTable,
  type EntityRunEntity,
  type EntityRunEventEntity,
  type EntityRunEventType,
  type EntityRunInitiator,
  type EntityRunMode,
  type EntityRunStatus,
} from "@/lib/db/schema";
import type { EntityKind } from "@/lib/backends/types";
import { admitRun } from "./admission";

/** DB row seed for `entity_run`; Runner derives `entityKind` /
 *  `entitySource` server-side before calling. */
export interface RunRowSeed {
  parentRunId?: string;
  threadId?: string;
  /** Schedule that triggered this run — set only when
   *  `initiator === "schedule"`. Persisted into
   *  `entity_run.schedule_id` for per-schedule history queries. */
  scheduleId?: string;
  initiator: EntityRunInitiator;
  entityId: string;
  entityKind: EntityKind;
  entitySource: "backend" | "builtin";
  credentialId?: string;
  mode: EntityRunMode;
  task: string;
  context?: Record<string, unknown>;
  params?: Record<string, unknown>;
  ownerId: string;
  createdBy: string;
  deadline?: Date;
}

/** Maximum recursion depth for parent → child run chains — prevents
 *  runaway delegation loops. See docs/orchestrator.md. */
const MAX_RECURSION_DEPTH = 3;

export class RecursionDepthExceeded extends Error {
  constructor(public readonly depth: number) {
    super(`Run recursion depth exceeded (${depth} > ${MAX_RECURSION_DEPTH})`);
    this.name = "RecursionDepthExceeded";
  }
}

async function recursionDepth(parentRunId: string | undefined): Promise<number> {
  if (!parentRunId) return 0;
  let depth = 1;
  let cursor: string | null = parentRunId;
  while (cursor && depth <= MAX_RECURSION_DEPTH + 1) {
    const rows: Array<{ parentRunId: string | null }> = await db
      .select({ parentRunId: EntityRunTable.parentRunId })
      .from(EntityRunTable)
      .where(eq(EntityRunTable.id, cursor))
      .limit(1);
    if (rows.length === 0) break;
    const next: string | null = rows[0].parentRunId ?? null;
    if (next === null) break;
    depth += 1;
    cursor = next;
  }
  return depth;
}

/**
 * CONTRACT: throws {@link RecursionDepthExceeded} when the parent
 * chain would exceed `MAX_RECURSION_DEPTH`. Returns the row in
 * `running` state on success.
 */
export async function recordRunStart(seed: RunRowSeed): Promise<EntityRunEntity> {
  // SECURITY (BUG-4): authorization invariant — must run first, before
  // any row is created. Non-bypassable by construction (every run-start
  // path funnels through here).
  await admitRun(seed);
  const depth = await recursionDepth(seed.parentRunId);
  if (depth > MAX_RECURSION_DEPTH) {
    throw new RecursionDepthExceeded(depth);
  }
  const now = new Date();
  const rows: EntityRunEntity[] = await db
    .insert(EntityRunTable)
    .values({
      parentRunId: seed.parentRunId,
      threadId: seed.threadId,
      scheduleId: seed.scheduleId,
      initiator: seed.initiator,
      entityId: seed.entityId,
      entityKind: seed.entityKind,
      entitySource: seed.entitySource,
      credentialId: seed.credentialId,
      mode: seed.mode,
      status: "running",
      inputTask: seed.task,
      inputContext: seed.context,
      inputParams: seed.params,
      ownerId: seed.ownerId,
      startedAt: now,
      deadline: seed.deadline,
      createdBy: seed.createdBy,
    })
    .returning();
  return rows[0];
}

/**
 * CONTRACT: idempotent — only writes when the row is still `running`,
 * so a late catch-handler can't overwrite a terminal status the
 * PersistingAgent already recorded.
 */
export async function finalizeRun(
  runId: string,
  status: EntityRunStatus,
  fields: {
    outputSummary?: string;
    outputArtifacts?: unknown;
    errorMessage?: string;
    errorDetails?: unknown;
  } = {},
): Promise<void> {
  await db
    .update(EntityRunTable)
    .set({
      status,
      finishedAt: new Date(),
      outputSummary: fields.outputSummary,
      outputArtifacts: fields.outputArtifacts as Record<string, unknown> | undefined,
      errorMessage: fields.errorMessage,
      errorDetails: fields.errorDetails as Record<string, unknown> | undefined,
    })
    .where(
      and(
        eq(EntityRunTable.id, runId),
        eq(EntityRunTable.status, "running"),
      ),
    );
}

/** CONTRACT: caller owns `seq` (monotonic per run from 0); duplicate
 *  seq is a caller bug. `ts` defaults to DB `CURRENT_TIMESTAMP`; pass a
 *  Node `Date` when the row represents the START of a coalesced range
 *  (e.g. first-token time) so TTFT metrics stay accurate.
 *  See docs/runner-events.md. */
export async function recordEvent(
  runId: string,
  seq: number,
  type: EntityRunEventType,
  payload: unknown,
  ts?: Date,
): Promise<void> {
  await db.insert(EntityRunEventTable).values({
    runId,
    seq,
    type,
    payload: payload as Record<string, unknown>,
    ...(ts ? { ts } : {}),
  });
}

/** Read the full event timeline of a run (oldest → newest).
 *  CONTRACT: ordered by `seq` ascending — callers (approval toolCallId
 *  resolution, chat-history reconstruction, trace metrics) rely on this;
 *  Postgres does not guarantee insertion order without ORDER BY. */
export async function readEvents(runId: string): Promise<EntityRunEventEntity[]> {
  return db
    .select()
    .from(EntityRunEventTable)
    .where(eq(EntityRunEventTable.runId, runId))
    .orderBy(asc(EntityRunEventTable.seq));
}
