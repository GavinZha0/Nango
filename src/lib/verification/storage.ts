/**
 * Verification — DB access layer.
 *
 * Thin Drizzle wrappers used by the runner, orchestrator, recovery
 * sweep, and API routes. Keeping all SQL here makes the other modules
 * cleanly testable with an in-memory stub.
 *
 * See docs/verification.md and docs/verification-group-and-prefix-plan.md.
 */

import "server-only";

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { visibilitySql } from "@/lib/auth/permissions";
import { alphabeticCompare } from "@/lib/utils/sort";
import {
  VerificationCaseResultTable,
  VerificationCaseTable,
  VerificationGroupTable,
  VerificationRunTable,
  VerificationSuiteTable,
  type VerificationCaseEntity,
  type VerificationCaseResultEntity,
  type VerificationGroupEntity,
  type VerificationRunEntity,
  type VerificationSuiteEntity,
} from "@/lib/db/schema";

import type {
  AssertionResult,
  AssertionSpec,
  CaseExecutionOutcome,
  ErrorEnvelope,
  VerificationRunStatus,
} from "./types";
import type { ToolPrefixRule } from "./tool-name";
import { getConfigNumber } from "@/lib/config";

// --- Groups -----------------------------------------------------------------

export async function getOrCreateGroupByName(
  name: string,
): Promise<VerificationGroupEntity> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Group name cannot be empty");
  }
  const existing = await db
    .select()
    .from(VerificationGroupTable)
    .where(sql`lower(${VerificationGroupTable.name}) = lower(${trimmed})`)
    .limit(1);
  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(VerificationGroupTable)
    .values({ name: trimmed })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [fallback] = await db
    .select()
    .from(VerificationGroupTable)
    .where(sql`lower(${VerificationGroupTable.name}) = lower(${trimmed})`)
    .limit(1);
  return fallback;
}

export async function renameGroup(
  id: string,
  newName: string,
): Promise<VerificationGroupEntity> {
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new Error("Group name cannot be empty");
  }
  const [row] = await db
    .update(VerificationGroupTable)
    .set({ name: trimmed, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(VerificationGroupTable.id, id))
    .returning();
  if (!row) {
    throw new Error(`Group not found: ${id}`);
  }
  return row;
}

export async function listGroupsWithActiveSuites(
  viewer: VerificationViewer,
): Promise<Array<VerificationGroupEntity & { suiteCount: number }>> {
  const whereClauses = [eq(VerificationSuiteTable.enabled, true)];
  if (!viewer.isAdmin) {
    whereClauses.push(
      visibilitySql(
        viewer,
        VerificationSuiteTable.visibility,
        VerificationSuiteTable.createdBy,
      ),
    );
  }

  const rows = await db
    .select({
      id: VerificationGroupTable.id,
      name: VerificationGroupTable.name,
      createdAt: VerificationGroupTable.createdAt,
      updatedAt: VerificationGroupTable.updatedAt,
      suiteCount: sql<number>`count(distinct ${VerificationSuiteTable.id})::int`,
    })
    .from(VerificationGroupTable)
    .innerJoin(
      VerificationSuiteTable,
      eq(VerificationSuiteTable.groupId, VerificationGroupTable.id),
    )
    .where(and(...whereClauses))
    .groupBy(
      VerificationGroupTable.id,
      VerificationGroupTable.name,
      VerificationGroupTable.createdAt,
      VerificationGroupTable.updatedAt,
    )
    .orderBy(VerificationGroupTable.name);
  return rows;
}

export async function listEnabledSuitesByGroup(
  groupId: string,
  viewer: VerificationViewer,
): Promise<
  Array<{
    id: string;
    name: string;
    mcpServerId: string | null;
    mcpServerName: string | null;
    toolPrefixRule: ToolPrefixRule | null;
  }>
> {
  const whereClauses = [
    eq(VerificationSuiteTable.enabled, true),
    eq(VerificationSuiteTable.groupId, groupId),
  ];

  if (!viewer.isAdmin) {
    whereClauses.push(
      visibilitySql(
        viewer,
        VerificationSuiteTable.visibility,
        VerificationSuiteTable.createdBy,
      ),
    );
  }

  return db
    .select({
      id: VerificationSuiteTable.id,
      name: VerificationSuiteTable.name,
      mcpServerId: VerificationSuiteTable.mcpServerId,
      mcpServerName: VerificationSuiteTable.mcpServerName,
      toolPrefixRule: VerificationSuiteTable.toolPrefixRule,
    })
    .from(VerificationSuiteTable)
    .where(and(...whereClauses))
    .orderBy(asc(VerificationSuiteTable.name));
}

// --- Suites -----------------------------------------------------------------

export interface CreateSuiteInput {
  name: string;
  description?: string | null;
  groupId?: string | null;
  mcpServerId?: string | null;
  mcpServerName?: string | null;
  toolPrefixRule?: ToolPrefixRule | null;
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
      groupId: input.groupId ?? null,
      mcpServerId: input.mcpServerId ?? null,
      mcpServerName: input.mcpServerName ?? null,
      toolPrefixRule: input.toolPrefixRule ?? null,
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

export async function listSuites(): Promise<VerificationSuiteEntity[]> {
  return db
    .select()
    .from(VerificationSuiteTable)
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
  suiteName?: string;
  name: string;
  input: unknown;
  assertions: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  mcpServerId: string | null;
  mcpServerName: string | null;
  toolName: string | null;
  toolPrefixRule: ToolPrefixRule | null;
  suiteVariables?: unknown;
}

/** Enabled cases of a suite, sorted in natural numeric-aware name order. */
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
      mcpServerName: VerificationSuiteTable.mcpServerName,
      toolName: VerificationCaseTable.toolName,
      toolPrefixRule: VerificationSuiteTable.toolPrefixRule,
      suiteVariables: VerificationSuiteTable.variables,
    })
    .from(VerificationCaseTable)
    .innerJoin(
      VerificationSuiteTable,
      eq(VerificationCaseTable.suiteId, VerificationSuiteTable.id),
    )
    .where(
      and(
        eq(VerificationCaseTable.suiteId, suiteId),
        eq(VerificationCaseTable.enabled, true),
      ),
    )
    .orderBy(VerificationCaseTable.name);
  return rows.sort((a, b) => alphabeticCompare(a.name, b.name));
}

/** Visibility scope for user-triggered queries. Shape matches the
 *  AuthContext accepted by `visibilitySql`; omit (or admin) = no filter —
 *  reserved for system contexts such as the boot recovery sweep. */
export interface VerificationViewer {
  userId: string;
  isAdmin: boolean;
  isEditor: boolean;
}

// --- Runs -------------------------------------------------------------------

export interface CreateRunInput {
  suiteId: string;
  totalCount: number;
  triggeredBy: "manual" | "schedule";
}

export async function createRun(
  input: CreateRunInput,
): Promise<VerificationRunEntity> {
  const [row] = await db
    .insert(VerificationRunTable)
    .values({
      suiteId: input.suiteId,
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

/** Total number of runs persisted for a suite. */
export async function countRuns(suiteId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(VerificationRunTable)
    .where(eq(VerificationRunTable.suiteId, suiteId));
  return rows[0]?.n ?? 0;
}

// --- Case results -----------------------------------------------------------

export interface WriteCaseResultInput {
  runId: string;
  caseId: number;
  outcome: CaseExecutionOutcome;
  inputSnapshot: unknown;
  originalToolName?: string | null;
  effectiveToolName?: string | null;
}

export async function writeCaseResult(
  input: WriteCaseResultInput,
): Promise<VerificationCaseResultEntity> {
  const { truncatedPayload, truncated } = truncatePayload(
    input.outcome.resultPayload,
  );

  const [row] = await db
    .insert(VerificationCaseResultTable)
    .values({
      runId: input.runId,
      caseId: input.caseId,
      status: input.outcome.status,
      originalToolName: input.originalToolName ?? null,
      effectiveToolName: input.effectiveToolName ?? null,
      inputSnapshot: input.inputSnapshot,
      resultPayload: truncatedPayload ?? null,
      resultTruncated: truncated,
      assertionResults: input.outcome.assertionResults as unknown,
      error: input.outcome.error as unknown,
      durationMs: input.outcome.durationMs,
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
): Promise<Array<Pick<VerificationRunEntity, "id" | "suiteId" | "totalCount">>> {
  return db
    .select({
      id: VerificationRunTable.id,
      suiteId: VerificationRunTable.suiteId,
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
 * `(run_id, case_id)` UNIQUE index.
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
  VerificationGroupEntity,
  VerificationSuiteEntity,
  VerificationCaseEntity,
  VerificationRunEntity,
  VerificationCaseResultEntity,
  AssertionSpec,
  AssertionResult,
  ErrorEnvelope,
};

function truncatePayload(
  raw: unknown,
): { truncatedPayload: unknown; truncated: boolean } {
  if (raw === null || raw === undefined) {
    return { truncatedPayload: raw, truncated: false };
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(raw);
  } catch {
    return {
      truncatedPayload: { __nonSerialisable: true, repr: String(raw) },
      truncated: true,
    };
  }
  const byteLength = Buffer.byteLength(serialised, "utf8");
  const maxBytes = getConfigNumber("verification.payload_max_kb", 32) * 1024;
  if (byteLength <= maxBytes) {
    return { truncatedPayload: raw, truncated: false };
  }
  return {
    truncatedPayload: {
      truncated_preview: serialised.slice(0, Math.floor(maxBytes / 2)),
    },
    truncated: true,
  };
}
