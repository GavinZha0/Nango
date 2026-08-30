/**
 * Web Auto — DB access layer.
 *
 * Thin Drizzle wrappers used by the runner, orchestrator, and API routes.
 * Keeping all SQL here makes the other modules trivially testable with an
 * in-memory stub.
 *
 * See docs/web-auto.md.
 */

import "server-only";

import { and, desc, eq, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { alphabeticCompare } from "@/lib/utils/sort";
import {
  WebAutoCaseResultTable,
  WebAutoCaseTable,
  WebAutoRunTable,
  WebAutoSuiteTable,
  type WebAutoCaseEntity,
  type WebAutoCaseResultEntity,
  type WebAutoRunEntity,
  type WebAutoSuiteEntity,
} from "@/lib/db/schema";

import type {
  WriteWebAutoCaseResultInput,
  WriteWebAutoRunInput,
  WebAutoVerdict,
  ErrorEnvelope,
} from "./types";
import { getConfigNumber } from "@/lib/config";

// --- Suites -----------------------------------------------------------------

export interface CreateWebAutoSuiteInput {
  name: string;
  description?: string | null;
  parentId?: string | null;
  variables?: Record<string, unknown>;
  visibility?: "private" | "public";
  timeoutSec?: number;
  evaluatorAgentId?: string | null;
  mcpServerId?: string | null;
  createdBy: string;
}

export async function createWebAutoSuite(
  input: CreateWebAutoSuiteInput,
): Promise<WebAutoSuiteEntity> {
  const [row] = await db
    .insert(WebAutoSuiteTable)
    .values({
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      variables: input.variables ?? {},
      visibility: input.visibility ?? "private",
      timeoutSec: input.timeoutSec ?? 300,
      evaluatorAgentId: input.evaluatorAgentId ?? null,
      mcpServerId: input.mcpServerId ?? null,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function getWebAutoSuiteById(
  id: string,
): Promise<WebAutoSuiteEntity | null> {
  const rows = await db
    .select()
    .from(WebAutoSuiteTable)
    .where(eq(WebAutoSuiteTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listWebAutoSuites(): Promise<WebAutoSuiteEntity[]> {
  return db
    .select()
    .from(WebAutoSuiteTable)
    .orderBy(WebAutoSuiteTable.name);
}

export async function updateWebAutoSuite(
  id: string,
  updates: Partial<CreateWebAutoSuiteInput>,
): Promise<WebAutoSuiteEntity> {
  const [row] = await db
    .update(WebAutoSuiteTable)
    .set({
      ...updates,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(WebAutoSuiteTable.id, id))
    .returning();
  return row;
}

export async function deleteWebAutoSuite(id: string): Promise<void> {
  await db
    .delete(WebAutoSuiteTable)
    .where(eq(WebAutoSuiteTable.id, id));
}

// --- Cases ------------------------------------------------------------------

export interface CreateWebAutoCaseInput {
  suiteId: string;
  name: string;
  input?: Record<string, unknown>;
  assertions?: unknown;
  enabled?: boolean;
  createdBy: string;
}

export async function createWebAutoCase(
  input: CreateWebAutoCaseInput,
): Promise<WebAutoCaseEntity> {
  const [row] = await db
    .insert(WebAutoCaseTable)
    .values({
      suiteId: input.suiteId,
      name: input.name,
      input: input.input ?? {},
      assertions: input.assertions ?? [],
      enabled: input.enabled ?? true,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function getWebAutoCaseById(
  id: number,
): Promise<WebAutoCaseEntity | null> {
  const rows = await db
    .select()
    .from(WebAutoCaseTable)
    .where(eq(WebAutoCaseTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listWebAutoCasesBySuite(
  suiteId: string,
): Promise<WebAutoCaseEntity[]> {
  return db
    .select()
    .from(WebAutoCaseTable)
    .where(eq(WebAutoCaseTable.suiteId, suiteId))
    .orderBy(WebAutoCaseTable.name);
}

export async function updateWebAutoCase(
  id: number,
  updates: Partial<Omit<CreateWebAutoCaseInput, "suiteId" | "createdBy">> & { updatedBy: string },
): Promise<WebAutoCaseEntity> {
  const [row] = await db
    .update(WebAutoCaseTable)
    .set({
      ...updates,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(WebAutoCaseTable.id, id))
    .returning();
  return row;
}

export async function deleteWebAutoCase(id: number): Promise<void> {
  await db
    .delete(WebAutoCaseTable)
    .where(eq(WebAutoCaseTable.id, id));
}

export interface WebAutoCaseRunItem {
  id: number;
  suiteId: string;
  name: string;
  input: unknown;
  assertions: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}

/** Enabled cases of a suite, sorted in natural name order. */
export async function listEnabledWebAutoCasesForRun(
  suiteId: string,
): Promise<WebAutoCaseRunItem[]> {
  const rows = await db
    .select({
      id: WebAutoCaseTable.id,
      suiteId: WebAutoCaseTable.suiteId,
      name: WebAutoCaseTable.name,
      input: WebAutoCaseTable.input,
      assertions: WebAutoCaseTable.assertions,
      enabled: WebAutoCaseTable.enabled,
      createdAt: WebAutoCaseTable.createdAt,
      updatedAt: WebAutoCaseTable.updatedAt,
    })
    .from(WebAutoCaseTable)
    .where(
      and(
        eq(WebAutoCaseTable.suiteId, suiteId),
        eq(WebAutoCaseTable.enabled, true),
      ),
    )
    .orderBy(WebAutoCaseTable.name);
  return rows.sort((a, b) => alphabeticCompare(a.name, b.name));
}

// --- Runs -------------------------------------------------------------------

export async function createWebAutoRun(
  input: WriteWebAutoRunInput,
): Promise<WebAutoRunEntity> {
  const [row] = await db
    .insert(WebAutoRunTable)
    .values({
      suiteId: input.suiteId,
      status: input.status,
      passed: input.passed,
      failed: input.failed,
      errored: input.errored,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export interface FinalizeWebAutoRunInput {
  runId: string;
  status: "passed" | "failed" | "errored";
  passedCount: number;
  failedCount: number;
  erroredCount: number;
}

export async function finalizeWebAutoRun(input: FinalizeWebAutoRunInput): Promise<void> {
  await db
    .update(WebAutoRunTable)
    .set({
      status: input.status,
      passed: input.passedCount,
      failed: input.failedCount,
      errored: input.erroredCount,
      finishedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(WebAutoRunTable.id, input.runId));
}

export async function getWebAutoRunById(
  id: string,
): Promise<WebAutoRunEntity | null> {
  const rows = await db
    .select()
    .from(WebAutoRunTable)
    .where(eq(WebAutoRunTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Paginated history for a suite. */
export async function listWebAutoRuns(
  suiteId: string,
  offset: number,
  limit: number,
): Promise<WebAutoRunEntity[]> {
  return db
    .select()
    .from(WebAutoRunTable)
    .where(eq(WebAutoRunTable.suiteId, suiteId))
    .orderBy(desc(WebAutoRunTable.startedAt))
    .offset(offset)
    .limit(limit);
}

/** Total number of runs for a suite. */
export async function countWebAutoRuns(suiteId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(WebAutoRunTable)
    .where(eq(WebAutoRunTable.suiteId, suiteId));
  return rows[0]?.n ?? 0;
}

// --- Case results -----------------------------------------------------------

export async function writeWebAutoCaseResult(
  input: WriteWebAutoCaseResultInput,
): Promise<WebAutoCaseResultEntity> {
  const { truncatedPayload } = truncatePayload(input.executionOutput);
  const assertionResults =
    input.assertionResults ??
    input.verdict?.deterministic?.results ??
    [];
  const score = input.score ?? input.verdict?.llm?.score ?? null;
  const feedback = input.feedback ?? input.verdict?.llm?.feedback ?? null;

  const [row] = await db
    .insert(WebAutoCaseResultTable)
    .values({
      runId: input.runId,
      caseId: input.caseId,
      status: input.status,
      executionOutput: truncatedPayload ?? null,
      assertionResults,
      score,
      feedback,
      error: input.error as unknown,
      durationMs: input.durationMs,
      startedAt: new Date(input.startedAt),
      finishedAt: input.finishedAt
        ? new Date(input.finishedAt)
        : new Date(input.startedAt + (input.durationMs || 0)),
      createdAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();
  return row;
}

export async function listWebAutoCaseResultsByRun(
  runId: string,
): Promise<WebAutoCaseResultEntity[]> {
  return db
    .select()
    .from(WebAutoCaseResultTable)
    .where(eq(WebAutoCaseResultTable.runId, runId))
    .orderBy(WebAutoCaseResultTable.createdAt);
}

// --- Recovery ---------------------------------------------------------------

/**
 * SELECT zombie web-auto runs from a prior Node process.
 */
export async function selectStrandedWebAutoRuns(
  bootStartedAt: Date,
): Promise<Array<Pick<WebAutoRunEntity, "id" | "suiteId">>> {
  return db
    .select({
      id: WebAutoRunTable.id,
      suiteId: WebAutoRunTable.suiteId,
    })
    .from(WebAutoRunTable)
    .where(
      and(
        eq(WebAutoRunTable.status, "running"),
        lt(WebAutoRunTable.startedAt, bootStartedAt),
      ),
    );
}

/**
 * IDs of cases that already have a persisted result for a given run.
 */
export async function listWrittenCaseIdsForWebAutoRun(
  runId: string,
): Promise<number[]> {
  const rows = await db
    .select({ caseId: WebAutoCaseResultTable.caseId })
    .from(WebAutoCaseResultTable)
    .where(eq(WebAutoCaseResultTable.runId, runId));
  return rows.map((r) => r.caseId);
}

/**
 * Bulk-insert `errored` filler rows for cases that never executed
 * because the Node process crashed mid-run.
 */
export async function writeErroredCaseResults(
  runId: string,
  caseIds: readonly number[],
): Promise<void> {
  if (caseIds.length === 0) return;
  await db
    .insert(WebAutoCaseResultTable)
    .values(
      caseIds.map((caseId) => ({
        runId,
        caseId,
        status: "errored" as const,
        executionOutput: null,
        verdict: {
          deterministic: { passed: false, results: [] },
          overall: { passed: false, reason: "Run was stranded by a process crash" },
        } satisfies WebAutoVerdict,
        error: {
          source: "crashed",
          message: "Run was stranded by a process crash before this case executed.",
        } satisfies ErrorEnvelope,
        createdAt: sql`CURRENT_TIMESTAMP`,
      })),
    )
    .onConflictDoNothing();
}

/** Flip stranded runs to `errored` in one statement. */
export async function markStrandedWebAutoRunsAsErrored(
  bootStartedAt: Date,
): Promise<void> {
  await db
    .update(WebAutoRunTable)
    .set({
      status: "errored",
      finishedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(WebAutoRunTable.status, "running"),
        lt(WebAutoRunTable.startedAt, bootStartedAt),
      ),
    );
}

// --- Re-exports for callers that just want types ----------------------------

export type {
  WebAutoSuiteEntity,
  WebAutoCaseEntity,
  WebAutoRunEntity,
  WebAutoCaseResultEntity,
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
  const maxBytes = getConfigNumber("web_auto.payload_max_kb", 32) * 1024;
  if (byteLength <= maxBytes) {
    return { truncatedPayload: raw, truncated: false };
  }
  return {
    truncatedPayload: { truncated_preview: serialised.slice(0, Math.floor(maxBytes / 2)) },
    truncated: true,
  };
}
