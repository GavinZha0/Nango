/**
 * Verification — DB access layer.
 *
 * Thin Drizzle wrappers used by the runner, orchestrator, recovery
 * sweep, and (Phase 3) API routes. Keeping all SQL here makes the
 * other modules trivially testable with an in-memory stub.
 *
 * See docs/verification.md.
 */

import "server-only";

import { and, desc, eq, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  VerificationCaseResultTable,
  VerificationCaseTable,
  VerificationRunTable,
  VerificationSuiteTable,
  type VerificationCaseEntity,
  type VerificationCaseResultEntity,
  type VerificationRunEntity,
  type VerificationSuiteEntity,
} from "@/lib/db/schema";

import type {
  AssertionResult,
  AssertionSpec,
  CaseExecutionOutcome,
  ErrorEnvelope,
  VerificationRunStatus,
  VerificationSuiteCategory,
} from "./types";
import { getConfigNumber } from "@/lib/config";

// --- Suites -----------------------------------------------------------------

export interface CreateSuiteInput {
  name: string;
  description?: string | null;
  category: VerificationSuiteCategory;
  visibility?: "private" | "public";
  timeoutSec?: number;
  createdBy: string;
}

export async function createSuite(
  input: CreateSuiteInput,
): Promise<VerificationSuiteEntity> {
  const [row] = await db
    .insert(VerificationSuiteTable)
    .values({
      name: input.name,
      description: input.description ?? null,
      category: input.category,
      visibility: input.visibility ?? "private",
      timeoutSec: input.timeoutSec ?? 300,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function getSuiteById(
  id: string,
): Promise<VerificationSuiteEntity | null> {
  const rows = await db
    .select()
    .from(VerificationSuiteTable)
    .where(eq(VerificationSuiteTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listSuites(
  category: VerificationSuiteCategory,
): Promise<VerificationSuiteEntity[]> {
  return db
    .select()
    .from(VerificationSuiteTable)
    .where(eq(VerificationSuiteTable.category, category))
    .orderBy(VerificationSuiteTable.name);
}

// --- Cases ------------------------------------------------------------------

export async function listCasesBySuite(
  suiteId: string,
): Promise<VerificationCaseEntity[]> {
  return db
    .select()
    .from(VerificationCaseTable)
    .where(eq(VerificationCaseTable.suiteId, suiteId))
    .orderBy(VerificationCaseTable.name);
}

export async function getCaseById(
  id: number,
): Promise<VerificationCaseEntity | null> {
  const rows = await db
    .select()
    .from(VerificationCaseTable)
    .where(eq(VerificationCaseTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface VerificationCaseRunItem {
  id: number;
  suiteId: string;
  name: string;
  input: unknown;
  assertions: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  mcpServerId: string | null;
  toolName: string | null;
  workflowId: string | null;
}

/** Enabled cases of a suite, in name order — the canonical iteration
 *  order for `Run suite` (see docs/verification.md). */
export async function listEnabledCasesForRun(
  suiteId: string,
): Promise<VerificationCaseRunItem[]> {
  const rows = await db
    .select({
      id: VerificationCaseTable.id,
      suiteId: VerificationCaseTable.suiteId,
      name: VerificationCaseTable.name,
      input: VerificationCaseTable.input,
      assertions: VerificationCaseTable.assertions,
      enabled: VerificationCaseTable.enabled,
      createdAt: VerificationCaseTable.createdAt,
      updatedAt: VerificationCaseTable.updatedAt,
      mcpServerId: VerificationSuiteTable.mcpServerId,
      toolName: VerificationSuiteTable.toolName,
      workflowId: VerificationSuiteTable.workflowId,
    })
    .from(VerificationCaseTable)
    .innerJoin(
      VerificationSuiteTable,
      eq(VerificationCaseTable.suiteId, VerificationSuiteTable.id)
    )
    .where(
      and(
        eq(VerificationCaseTable.suiteId, suiteId),
        eq(VerificationCaseTable.enabled, true),
      ),
    )
    .orderBy(VerificationCaseTable.name);
  return rows;
}

/** Enabled cases of an entire MCP server, in toolName and case name order. */
export async function listEnabledCasesForServerRun(
  mcpServerId: string,
): Promise<VerificationCaseRunItem[]> {
  const rows = await db
    .select({
      id: VerificationCaseTable.id,
      suiteId: VerificationCaseTable.suiteId,
      name: VerificationCaseTable.name,
      input: VerificationCaseTable.input,
      assertions: VerificationCaseTable.assertions,
      enabled: VerificationCaseTable.enabled,
      createdAt: VerificationCaseTable.createdAt,
      updatedAt: VerificationCaseTable.updatedAt,
      mcpServerId: VerificationSuiteTable.mcpServerId,
      toolName: VerificationSuiteTable.toolName,
      workflowId: VerificationSuiteTable.workflowId,
    })
    .from(VerificationCaseTable)
    .innerJoin(
      VerificationSuiteTable,
      eq(VerificationCaseTable.suiteId, VerificationSuiteTable.id)
    )
    .where(
      and(
        eq(VerificationSuiteTable.mcpServerId, mcpServerId),
        eq(VerificationCaseTable.enabled, true),
      ),
    )
    .orderBy(VerificationSuiteTable.toolName, VerificationCaseTable.name);
  return rows;
}

// --- Runs -------------------------------------------------------------------

export interface CreateRunInput {
  suiteId?: string | null;
  mcpServerId?: string | null;
  totalCount: number;
  triggeredBy: "manual" | "schedule";
}

export async function createRun(
  input: CreateRunInput,
): Promise<VerificationRunEntity> {
  const [row] = await db
    .insert(VerificationRunTable)
    .values({
      suiteId: input.suiteId ?? null,
      mcpServerId: input.mcpServerId ?? null,
      status: "running",
      totalCount: input.totalCount,
      triggeredBy: input.triggeredBy,
    })
    .returning();
  return row;
}

export interface FinalizeRunInput {
  runId: string;
  status: VerificationRunStatus;
  passedCount: number;
  failedCount: number;
  erroredCount: number;
  skippedCount: number;
}

export async function finalizeRun(input: FinalizeRunInput): Promise<void> {
  await db
    .update(VerificationRunTable)
    .set({
      status: input.status,
      passedCount: input.passedCount,
      failedCount: input.failedCount,
      erroredCount: input.erroredCount,
      skippedCount: input.skippedCount,
      finishedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(VerificationRunTable.id, input.runId));
}

export async function getRunById(
  id: string,
): Promise<VerificationRunEntity | null> {
  const rows = await db
    .select()
    .from(VerificationRunTable)
    .where(eq(VerificationRunTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Paginated history for the recent-runs banner. */
export async function listRecentRuns(
  suiteId: string,
  offset: number,
  limit: number,
): Promise<VerificationRunEntity[]> {
  return db
    .select()
    .from(VerificationRunTable)
    .where(eq(VerificationRunTable.suiteId, suiteId))
    .orderBy(desc(VerificationRunTable.startedAt))
    .offset(offset)
    .limit(limit);
}

/** Total number of runs persisted for a suite. Used by the banner
 *  to label chips with their absolute run sequence number and to
 *  drive precise "older" pagination enable/disable. */
export async function countRuns(suiteId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(VerificationRunTable)
    .where(eq(VerificationRunTable.suiteId, suiteId));
  return rows[0]?.n ?? 0;
}

/** Paginated history for the recent-runs banner (Server level). */
export async function listRecentServerRuns(
  mcpServerId: string,
  offset: number,
  limit: number,
): Promise<VerificationRunEntity[]> {
  return db
    .select()
    .from(VerificationRunTable)
    .where(eq(VerificationRunTable.mcpServerId, mcpServerId))
    .orderBy(desc(VerificationRunTable.startedAt))
    .offset(offset)
    .limit(limit);
}

/** Total number of runs persisted for a server. */
export async function countServerRuns(mcpServerId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(VerificationRunTable)
    .where(eq(VerificationRunTable.mcpServerId, mcpServerId));
  return rows[0]?.n ?? 0;
}

// --- Case results -----------------------------------------------------------

export interface WriteCaseResultInput {
  runId: string;
  caseId: number;
  outcome: CaseExecutionOutcome;
  inputSnapshot: unknown;
}

export async function writeCaseResult(
  input: WriteCaseResultInput,
): Promise<VerificationCaseResultEntity> {
  const { truncatedPayload, truncated } = truncatePayload(input.outcome.resultPayload);

  const [row] = await db
    .insert(VerificationCaseResultTable)
    .values({
      runId: input.runId,
      caseId: input.caseId,
      status: input.outcome.status,
      // V1: MCP cases only — entity_run_id always null. V2 will set
      // this from runner.start for workflow cases.
      entityRunId: null,
      inputSnapshot: input.inputSnapshot,
      resultPayload: truncatedPayload ?? null,
      resultTruncated: truncated,
      assertionResults: input.outcome.assertionResults as unknown,
      error: input.outcome.error as unknown,
      durationMs: input.outcome.durationMs,
      // started_at + finished_at are derived from the outcome's wall-
      // clock window rather than left to the DB default. Without this
      // both timestamps collapsed to the INSERT moment (≈ finishedAt),
      // making `started_at + duration_ms ≠ finished_at` and breaking
      // any future timeline / gantt rendering of case execution order.
      startedAt: new Date(input.outcome.startedAt),
      finishedAt: new Date(input.outcome.startedAt + input.outcome.durationMs),
    })
    .returning();
  return row;
}

export async function listResultsByRun(
  runId: string,
): Promise<VerificationCaseResultEntity[]> {
  return db
    .select()
    .from(VerificationCaseResultTable)
    .where(eq(VerificationCaseResultTable.runId, runId))
    .orderBy(VerificationCaseResultTable.startedAt);
}

// --- Recovery ---------------------------------------------------------------

/**
 * SELECT zombie verification runs from a prior Node process.
 *
 * Match the recovery shape used by `runner/recovery.ts` —
 * `status='running' AND started_at < bootStartedAt`.
 */
export async function selectStrandedRuns(
  bootStartedAt: Date,
): Promise<Array<Pick<VerificationRunEntity, "id" | "suiteId" | "mcpServerId" | "totalCount">>> {
  return db
    .select({
      id: VerificationRunTable.id,
      suiteId: VerificationRunTable.suiteId,
      mcpServerId: VerificationRunTable.mcpServerId,
      totalCount: VerificationRunTable.totalCount,
    })
    .from(VerificationRunTable)
    .where(
      and(
        eq(VerificationRunTable.status, "running"),
        lt(VerificationRunTable.startedAt, bootStartedAt),
      ),
    );
}

/**
 * IDs of cases that already have a persisted result for a given run.
 * Recovery uses this to compute which (run, case) tuples need a
 * `skipped` filler row written before the run is flipped to `errored`.
 */
export async function listWrittenCaseIdsForRun(
  runId: string,
): Promise<number[]> {
  const rows = await db
    .select({ caseId: VerificationCaseResultTable.caseId })
    .from(VerificationCaseResultTable)
    .where(eq(VerificationCaseResultTable.runId, runId));
  return rows.map((r) => r.caseId);
}

/**
 * Bulk-insert `skipped` filler rows for cases that never executed
 * because the Node process crashed mid-run. Idempotent via the
 * `(run_id, case_id)` UNIQUE index — repeated recovery passes
 * (e.g. crash during recovery itself) silently no-op rather than
 * raising.
 *
 * `error.source = "crashed"` so the UI can distinguish this filler
 * row from a genuine runner-internal bug (`source = "internal"`).
 */
export async function writeSkippedCaseResults(
  runId: string,
  caseIds: readonly number[],
): Promise<void> {
  if (caseIds.length === 0) return;
  await db
    .insert(VerificationCaseResultTable)
    .values(
      caseIds.map((caseId) => ({
        runId,
        caseId,
        status: "skipped" as const,
        entityRunId: null,
        // `inputSnapshot` is NOT NULL in schema; we don't have the
        // original input here (would require an extra fetch per case)
        // and the UI treats `skipped` rows as "did not execute"
        // anyway, so an empty object is the minimum viable filler.
        inputSnapshot: {},
        resultPayload: null,
        resultTruncated: false,
        assertionResults: [],
        error: {
          source: "crashed",
          message:
            "Run was stranded by a process crash before this case executed.",
        } satisfies ErrorEnvelope,
        durationMs: 0,
        startedAt: sql`CURRENT_TIMESTAMP`,
        finishedAt: sql`CURRENT_TIMESTAMP`,
      })),
    )
    .onConflictDoNothing();
}

/** Flip stranded runs to `errored` in one statement. */
export async function markStrandedAsErrored(
  bootStartedAt: Date,
): Promise<void> {
  await db
    .update(VerificationRunTable)
    .set({
      status: "errored",
      finishedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(VerificationRunTable.status, "running"),
        lt(VerificationRunTable.startedAt, bootStartedAt),
      ),
    );
}

// --- Re-exports for callers that just want types ----------------------------

export type {
  VerificationSuiteEntity,
  VerificationCaseEntity,
  VerificationRunEntity,
  VerificationCaseResultEntity,
  AssertionSpec,
  AssertionResult,
  ErrorEnvelope,
};

function truncatePayload(raw: unknown): { truncatedPayload: unknown; truncated: boolean } {
  if (raw === null || raw === undefined) return { truncatedPayload: raw, truncated: false };
  let serialised: string;
  try {
    serialised = JSON.stringify(raw);
  } catch {
    return { truncatedPayload: { __nonSerialisable: true, repr: String(raw) }, truncated: true };
  }
  const byteLength = Buffer.byteLength(serialised, "utf8");
  const maxBytes = getConfigNumber("verification.payload_max_kb", 24) * 1024;
  if (byteLength <= maxBytes) {
    return { truncatedPayload: raw, truncated: false };
  }
  return {
    truncatedPayload: { truncated_preview: serialised.slice(0, Math.floor(maxBytes / 2)) },
    truncated: true,
  };
}
