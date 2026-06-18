/**
 * Evaluation — DB access layer.
 *
 * Thin Drizzle wrappers for eval_suite, eval_case, eval_run, and
 * eval_case_result. Mirrors the verification/storage.ts pattern.
 */

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

// --- Cases ------------------------------------------------------------------

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

// --- Aggregate queries (left panel) -----------------------------------------

/** Agent row for the left panel — one per distinct (agent_id, agent_source). */
export interface EvalAgentRow {
  agentId: string;
  agentSource: string;
  credentialId: string | null;
  suiteCount: number;
  caseCount: number;
}

/** Returns distinct agents that have at least one eval suite, with counts. */
export async function listAgentsWithEval(): Promise<EvalAgentRow[]> {
  const rows = await db
    .select({
      agentId: EvalSuiteTable.agentId,
      agentSource: EvalSuiteTable.agentSource,
      credentialId: sql<string | null>`min(${EvalSuiteTable.credentialId}::text)::uuid`,
      suiteCount: sql<number>`count(distinct ${EvalSuiteTable.id})::int`,
      caseCount: sql<number>`count(${EvalCaseTable.id})::int`,
    })
    .from(EvalSuiteTable)
    .leftJoin(EvalCaseTable, eq(EvalCaseTable.suiteId, EvalSuiteTable.id))
    .groupBy(EvalSuiteTable.agentId, EvalSuiteTable.agentSource)
    .orderBy(asc(EvalSuiteTable.agentId));
  return rows;
}

/** Suite row for the editor — includes case count. */
export interface EvalSuiteRow extends EvalSuiteEntity {
  caseCount: number;
}

export async function listSuitesByAgentWithCaseCount(
  agentId: string,
  agentSource: string = "builtin",
): Promise<EvalSuiteRow[]> {
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
      sql`${EvalSuiteTable.agentId} = ${agentId} AND ${EvalSuiteTable.agentSource} = ${agentSource}`,
    )
    .orderBy(asc(EvalSuiteTable.name));
  return rows;
}

// --- Recent run history (placeholder for future) ----------------------------

export async function listRecentRuns(
  _suiteId: string,
  _limit: number = 10,
): Promise<unknown[]> {
  // QUIRK: eval_run queries will be wired when the run executor lands.
  return [];
}
