/** Evaluation — DB access layer. See docs/evaluation.md. */

import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  EvalCaseTable,
  EvalSuiteTable,
  type EvalCaseEntity,
  type EvalSuiteEntity,
} from "@/lib/db/schema";

// --- Suites -----------------------------------------------------------------

export interface CreateSuiteInput {
  agentId: string;
  agentSource?: string;
  credentialId?: string | null;
  evaluatorAgentId?: string | null;
  name: string;
  description?: string | null;
  dimensionIds?: string[];
  enabled?: boolean;
  createdBy: string;
}

export async function createSuite(
  input: CreateSuiteInput,
): Promise<EvalSuiteEntity> {
  const [row] = await db
    .insert(EvalSuiteTable)
    .values({
      agentId: input.agentId,
      agentSource: input.agentSource ?? "builtin",
      credentialId: input.credentialId ?? null,
      evaluatorAgentId: input.evaluatorAgentId ?? null,
      name: input.name,
      description: input.description ?? null,
      dimensionIds: input.dimensionIds ?? [],
      enabled: input.enabled ?? true,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function getSuiteById(
  id: string,
): Promise<EvalSuiteEntity | null> {
  const rows = await db
    .select()
    .from(EvalSuiteTable)
    .where(eq(EvalSuiteTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listSuitesByAgent(
  agentId: string,
  agentSource: string = "builtin",
): Promise<EvalSuiteEntity[]> {
  return db
    .select()
    .from(EvalSuiteTable)
    .where(
      sql`${EvalSuiteTable.agentId} = ${agentId} AND ${EvalSuiteTable.agentSource} = ${agentSource}`,
    )
    .orderBy(asc(EvalSuiteTable.name));
}

export interface UpdateSuiteInput {
  name?: string;
  description?: string | null;
  evaluatorAgentId?: string | null;
  dimensionIds?: string[];
  enabled?: boolean;
}

export async function updateSuite(
  id: string,
  input: UpdateSuiteInput,
  updatedBy: string,
): Promise<EvalSuiteEntity> {
  const updates: Record<string, unknown> = { updatedBy };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.evaluatorAgentId !== undefined)
    updates.evaluatorAgentId = input.evaluatorAgentId;
  if (input.dimensionIds !== undefined) updates.dimensionIds = input.dimensionIds;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  updates.updatedAt = sql`CURRENT_TIMESTAMP`;

  const [row] = await db
    .update(EvalSuiteTable)
    .set(updates)
    .where(eq(EvalSuiteTable.id, id))
    .returning();
  return row;
}

export async function deleteSuite(id: string): Promise<void> {
  await db.delete(EvalSuiteTable).where(eq(EvalSuiteTable.id, id));
}

// --- Cases ------------------------------------------------------------------

export async function getCaseCount(suiteId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(EvalCaseTable)
    .where(eq(EvalCaseTable.suiteId, suiteId));
  return count;
}

export interface CreateCaseInput {
  suiteId: string;
  name: string;
  turns?: unknown[];
  criteria?: Record<string, unknown>;
  dimensionOverride?: string[] | null;
  enabled?: boolean;
}

export async function createCase(
  input: CreateCaseInput,
): Promise<EvalCaseEntity> {
  const [row] = await db
    .insert(EvalCaseTable)
    .values({
      suiteId: input.suiteId,
      name: input.name,
      turns: (input.turns ?? []) as unknown,
      criteria: (input.criteria ?? {}) as unknown,
      dimensionOverride: input.dimensionOverride ?? null,
      enabled: input.enabled ?? true,
    })
    .returning();
  return row;
}

export async function getCaseById(
  id: number,
): Promise<EvalCaseEntity | null> {
  const rows = await db
    .select()
    .from(EvalCaseTable)
    .where(eq(EvalCaseTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCasesBySuite(
  suiteId: string,
): Promise<EvalCaseEntity[]> {
  return db
    .select()
    .from(EvalCaseTable)
    .where(eq(EvalCaseTable.suiteId, suiteId))
    .orderBy(asc(EvalCaseTable.name));
}

export interface UpdateCaseInput {
  name?: string;
  turns?: unknown[];
  criteria?: Record<string, unknown>;
  dimensionOverride?: string[] | null;
  enabled?: boolean;
}

export async function updateCase(
  id: number,
  input: UpdateCaseInput,
): Promise<EvalCaseEntity> {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.turns !== undefined) updates.turns = input.turns as unknown;
  if (input.criteria !== undefined) updates.criteria = input.criteria as unknown;
  if (input.dimensionOverride !== undefined)
    updates.dimensionOverride = input.dimensionOverride;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  updates.updatedAt = sql`CURRENT_TIMESTAMP`;

  const [row] = await db
    .update(EvalCaseTable)
    .set(updates)
    .where(eq(EvalCaseTable.id, id))
    .returning();
  return row;
}

export async function deleteCase(id: number): Promise<void> {
  await db.delete(EvalCaseTable).where(eq(EvalCaseTable.id, id));
}

// --- Aggregate queries ------------------------------------------------------

export interface EvalAgentRow {
  agentId: string;
  agentSource: string;
  credentialId: string | null;
  suiteCount: number;
  caseCount: number;
}

export async function listAgentsWithEval(
  userId: string,
  isAdmin: boolean = false,
): Promise<EvalAgentRow[]> {
  const query = db
    .select({
      agentId: EvalSuiteTable.agentId,
      agentSource: EvalSuiteTable.agentSource,
      credentialId: sql<string | null>`min(${EvalSuiteTable.credentialId}::text)::uuid`,
      suiteCount: sql<number>`count(distinct ${EvalSuiteTable.id})::int`,
      caseCount: sql<number>`count(${EvalCaseTable.id})::int`,
    })
    .from(EvalSuiteTable)
    .leftJoin(EvalCaseTable, eq(EvalCaseTable.suiteId, EvalSuiteTable.id));

  if (!isAdmin) {
    query.where(eq(EvalSuiteTable.createdBy, userId));
  }

  const rows = await query
    .groupBy(EvalSuiteTable.agentId, EvalSuiteTable.agentSource)
    .orderBy(asc(EvalSuiteTable.agentId));
  return rows;
}

export interface EvalSuiteRow extends EvalSuiteEntity {
  caseCount: number;
}

export async function listSuitesByAgentWithCaseCount(
  agentId: string,
  agentSource: string,
  userId: string,
  isAdmin: boolean = false,
): Promise<EvalSuiteRow[]> {
  const createdByClause = isAdmin
    ? sql`true`
    : sql`${EvalSuiteTable.createdBy} = ${userId}`;

  const rows = await db
    .select({
      id: EvalSuiteTable.id,
      agentId: EvalSuiteTable.agentId,
      agentSource: EvalSuiteTable.agentSource,
      credentialId: EvalSuiteTable.credentialId,
      evaluatorAgentId: EvalSuiteTable.evaluatorAgentId,
      name: EvalSuiteTable.name,
      description: EvalSuiteTable.description,
      dimensionIds: EvalSuiteTable.dimensionIds,
      enabled: EvalSuiteTable.enabled,
      createdBy: EvalSuiteTable.createdBy,
      updatedBy: EvalSuiteTable.updatedBy,
      createdAt: EvalSuiteTable.createdAt,
      updatedAt: EvalSuiteTable.updatedAt,
      caseCount: sql<number>`(
        select count(*)::int from "eval_case"
        where "eval_case"."suite_id" = "eval_suite"."id"
      )`,
    })
    .from(EvalSuiteTable)
    .where(
      sql`${EvalSuiteTable.agentId} = ${agentId}
        AND ${EvalSuiteTable.agentSource} = ${agentSource}
        AND ${createdByClause}`,
    )
    .orderBy(asc(EvalSuiteTable.name));
  return rows;
}

// --- Run history (Stage 2) --------------------------------------------------

/** Placeholder — will be wired when the run executor lands. */
export async function listRecentRuns(
  _suiteId: string,
  _limit: number = 10,
): Promise<unknown[]> {
  return [];
}
