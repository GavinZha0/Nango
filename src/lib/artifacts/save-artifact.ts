/**
 * Save-artifact orchestrator — the impure I/O layer on top of the
 * pure spec-extraction pipeline (`buildWorkflowSpecFromRunEvents`).
 * Idempotent on `(source_thread_id, source_outcome_id)`.
 *
 * See docs/workflow.md.
 */

import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { logger as observabilityLogger } from "@/lib/observability/logger";

import { db } from "@/lib/db";
import {
  ArtifactTable,
  EntityRunEventTable,
  EntityRunTable,
  WorkflowTable,
} from "@/lib/db/schema";
import {
  buildWorkflowSpecFromRunEvents,
  canonicalize,
  type CanonicalizeDeps,
  type SaveLineageReport,
  validate,
  type LLMWorkflowSpec,
} from "@/lib/workflows";
import { WorkflowError } from "@/lib/workflows/error";
import type { ArtifactType } from "@/lib/domain/artifact";

import { coalesceToolCalls } from "./coalesce-tool-calls";
import { executeWorkflow } from "./execute-workflow";

// ─── Public surface ────────────────────────────────────────────────────

export interface SaveArtifactInput {
  /** Caller user id — owner of the new artifact + workflow rows. */
  ownerId: string;
  /** Chat thread the outcome belongs to. Drives both idempotency
   *  and the cross-run event search. */
  threadId: string;
  /** Producer-chosen stable id (`Outcome.outcomeId`). For
   *  `generate_echarts_config` this is the LLM's `chart_id`. */
  outcomeId: string;
  /** Optional folder. `saveArtifact` does NOT auto-route to a seed
   *  category when omitted — programmatic callers wanting that
   *  must resolve `parentId` themselves. */
  parentId?: string;
  /** Optional name override. Falls through to `deriveArtifactName()`. */
  name?: string;
  /** Verbatim, stored on the row's `description` column. */
  description?: string | null;
}

export interface SaveArtifactDeps {
  /** Tool-registry view; passed through to canonicalize. */
  getToolMetadata: CanonicalizeDeps["getToolMetadata"];
  /** EntityCatalog view; passed through to canonicalize. */
  resolveAgentId: CanonicalizeDeps["resolveAgentId"];
  /** Data-source catalog view; passed through to canonicalize. */
  resolveDataSourceId: CanonicalizeDeps["resolveDataSourceId"];
}

export interface SaveArtifactResult {
  artifactId: string;
  workflowId: string;
  workflowOutputField: string;
  /** True if an existing artifact was returned (idempotent save). */
  reused: boolean;
}

/**
 * Stub wiring for development / tool-only workflows. Agent and
 * SQL node resolution always fails; tool metadata is empty.
 *
 * @deprecated Use `buildProductionSaveDeps(ownerId)` from
 * `./save-deps.server.ts` for real DB-backed resolution.
 */
export const stubSaveDeps: SaveArtifactDeps = {
  getToolMetadata: async () => ({}),
  resolveAgentId: async () => null,
  resolveDataSourceId: async () => null,
};

// ─── Entry point ───────────────────────────────────────────────────────

/**
 * Save an artifact + its extracted workflow from a chat run.
 * Throws `WorkflowError` on spec validation failures (canonicalize
 * / validate); throws `ApiError` on access / not-found issues.
 */
export async function saveArtifact(
  input: SaveArtifactInput,
  deps: SaveArtifactDeps,
): Promise<SaveArtifactResult> {
  // Fast-path idempotency check — avoids the heavy event-walk +
  // canonicalize pipeline for the common "user double-clicked save"
  // case. The authoritative guard is the unique index on
  // (source_thread_id, source_outcome_id) enforced inside the
  // transaction below.
  const existing = await findExistingArtifact({
    ownerId: input.ownerId,
    sourceThreadId: input.threadId,
    sourceOutcomeId: input.outcomeId,
  });
  if (existing !== null) {
    return {
      artifactId: existing.artifactId,
      workflowId: existing.workflowId,
      workflowOutputField: existing.workflowOutputField,
      reused: true,
    };
  }

  // Resolve outcomeId → (runId, toolCallId). The outcome's id
  // (`chart_id` for generate_echarts_config) is embedded in a
  // `tool_call_chunk` event's args somewhere in the thread; the
  // chunk also carries the OpenAI `toolCallId` we need to identify
  // the artifact creator.
  const resolution = await resolveOutcomeToCall({
    threadId: input.threadId,
    outcomeId: input.outcomeId,
    ownerId: input.ownerId,
  });

  // Cross-run load: chat tool calls routinely span multiple runs
  // (chunk + result in turn N, replayed result in turn N+1). The
  // coalescer pins each toolCallId to its origin run to avoid
  // double-concatenation.
  const rawEvents = await loadThreadEvents(input.threadId, input.ownerId);
  const invocations = coalesceToolCalls(rawEvents);

  // Pure pipeline: events → LLM spec + lineage.
  const built = buildWorkflowSpecFromRunEvents({
    invocations,
    artifactCreatingCallId: resolution.toolCallId,
  });

  // Canonicalize (fills `type` tag, agentId, registry schemas).
  const canonical = await canonicalize(built.spec, deps);

  // Validate (DAG, cycles, ref reachability, top-level outputs).
  validate(canonical);

  // Atomic persistence with idempotency guard inside the
  // transaction. If a concurrent request inserted the same
  // (source_thread_id, source_outcome_id) between our fast-path
  // check and this point, the unique index causes a conflict.
  // We catch it and return the winner's row.
  const workflowName = canonical.name;
  const workflowOutputField = pickWorkflowOutputField(built.spec);

  let result: { artifactId: string; workflowId: string; reused: boolean };
  try {
    const inserted = await db.transaction(async (tx) => {
      // Re-check inside the transaction — narrows the race window
      // to the DB serialization level. The unique index is the
      // ultimate backstop.
      const dup = await findExistingArtifactTx(tx, {
        ownerId: input.ownerId,
        sourceThreadId: input.threadId,
        sourceOutcomeId: input.outcomeId,
      });
      if (dup !== null) return { ...dup, reused: true as const };

      const [workflowRow] = await tx
        .insert(WorkflowTable)
        .values({
          name: workflowName,
          spec: canonical,
          visibility: "private",
          createdBy: input.ownerId,
          updatedBy: input.ownerId,
        })
        .returning({ id: WorkflowTable.id });
      if (workflowRow === undefined) {
        throw new Error("saveArtifact: workflow row insert returned no id.");
      }

      const [artifactRow] = await tx
        .insert(ArtifactTable)
        .values({
          kind: "artifact",
          type: deriveArtifactType(built.artifactCreatorToolName),
          name:
            input.name?.trim()?.length
              ? input.name.trim().slice(0, 200)
              : deriveArtifactName(built.spec, built.strippedFrontendConfig),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          sourceThreadId: input.threadId,
          sourceOutcomeId: input.outcomeId,
          workflowId: workflowRow.id,
          workflowOutputField,
          ...(input.parentId !== undefined && { parentId: input.parentId }),
          createdBy: input.ownerId,
        })
        .returning({ id: ArtifactTable.id });
      if (artifactRow === undefined) {
        throw new Error("saveArtifact: artifact row insert returned no id.");
      }

      // Lineage telemetry — single event, source-of-truth for admin
      // run forensics.
      await insertLineageEvent(tx, resolution.runId, built.lineageReport);

      return {
        artifactId: artifactRow.id,
        workflowId: workflowRow.id,
        reused: false as const,
      };
    });
    result = inserted;
  } catch (err) {
    // Unique-index violation from a concurrent insert — the other
    // request won the race. Re-query and return the winner's row.
    if (isUniqueViolation(err)) {
      const winner = await findExistingArtifact({
        ownerId: input.ownerId,
        sourceThreadId: input.threadId,
        sourceOutcomeId: input.outcomeId,
      });
      if (winner !== null) {
        return {
          artifactId: winner.artifactId,
          workflowId: winner.workflowId,
          workflowOutputField: winner.workflowOutputField,
          reused: true,
        };
      }
    }
    throw err;
  }

  if (result.reused) {
    return {
      artifactId: result.artifactId,
      workflowId: result.workflowId,
      workflowOutputField,
      reused: true,
    };
  }

  // Create initial snapshot — execute the workflow once (uses SQL
  // Parquet cache; fast) and persist the output as the first snapshot
  // so the artifact is immediately useful when opened in snapshot mode.
  // Non-fatal: a failure here does not fail the save; the user can
  // trigger a manual snapshot later.
  try {
    const resolution = await executeWorkflow({
      workflowId: result.workflowId,
      spec: canonical,
      outputField: workflowOutputField,
      ownerId: input.ownerId,
      forceFresh: false,
    });
    if (resolution !== null && resolution.data !== undefined) {
      await db
        .update(ArtifactTable)
        .set({
          snapshot: resolution.data as Record<string, unknown>,
          snapshotAt: resolution.executedAt,
        })
        .where(eq(ArtifactTable.id, result.artifactId));
    }
  } catch (snapshotErr) {
    observabilityLogger.warn(
      {
        err: snapshotErr,
        artifactId: result.artifactId,
        workflowId: result.workflowId,
      },
      "initial snapshot creation failed (non-fatal)",
    );
  }

  return {
    artifactId: result.artifactId,
    workflowId: result.workflowId,
    workflowOutputField,
    reused: false,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────

/**
 * Resolve a frontend outcomeId to the originating (runId, toolCallId).
 *
 * `outcomeId` is producer-chosen — generate_echarts_config uses the
 * LLM's `chart_id` argument; web_search uses the OpenAI callId.
 * Match either the callId directly or any top-level string-valued
 * arg equal to `outcomeId`. First chronological match wins.
 *
 * Throws `WorkflowError` (`UNKNOWN_ERROR`) when no match exists.
 */
async function resolveOutcomeToCall(args: {
  threadId: string;
  outcomeId: string;
  ownerId: string;
}): Promise<{ runId: string; toolCallId: string }> {
  const chunkRows = await db
    .select({
      runId: EntityRunEventTable.runId,
      seq: EntityRunEventTable.seq,
      type: EntityRunEventTable.type,
      payload: EntityRunEventTable.payload,
      ts: EntityRunEventTable.ts,
    })
    .from(EntityRunEventTable)
    .innerJoin(
      EntityRunTable,
      eq(EntityRunTable.id, EntityRunEventTable.runId),
    )
    .where(
      and(
        eq(EntityRunTable.threadId, args.threadId),
        eq(EntityRunTable.ownerId, args.ownerId),
        eq(EntityRunEventTable.type, "tool_call_chunk"),
      ),
    )
    .orderBy(asc(EntityRunEventTable.ts), asc(EntityRunEventTable.seq));

  // Coalesce so multi-chunk args (Vercel AI SDK streams args
  // incrementally) end up as a single parseable object. Passing
  // runId on each event pins each toolCallId to its origin run
  // and ignores replayed chunks.
  const invocations = coalesceToolCalls(chunkRows);

  // `ToolInvocation` doesn't carry runId — re-derive from the
  // chunk rows. First chunk per toolCallId wins.
  const runIdByCall = new Map<string, string>();
  for (const row of chunkRows) {
    const p = row.payload;
    if (p === null || typeof p !== "object") continue;
    const id = (p as { toolCallId?: unknown }).toolCallId;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!runIdByCall.has(id)) runIdByCall.set(id, row.runId);
  }

  for (const inv of invocations) {
    if (inv.callId === args.outcomeId) {
      const runId = runIdByCall.get(inv.callId);
      if (runId !== undefined) {
        return { runId, toolCallId: inv.callId };
      }
    }
    // Producer-chosen ids embedded in args (chart_id, …). Match any
    // top-level string value equal to outcomeId.
    for (const value of Object.values(inv.inputs)) {
      if (typeof value === "string" && value === args.outcomeId) {
        const runId = runIdByCall.get(inv.callId);
        if (runId !== undefined) {
          return { runId, toolCallId: inv.callId };
        }
      }
    }
  }

  throw new WorkflowError({
    errorCode: "UNKNOWN_ERROR",
    message: `No tool call in thread ${args.threadId} produced outcome ${args.outcomeId}.`,
  });
}

/**
 * Load every `tool_call_chunk` + `tool_call_result` row in the
 * thread, ordered by (ts, seq). Each row carries its `runId` so
 * the coalescer can pin a toolCallId to its origin run.
 */
async function loadThreadEvents(
  threadId: string,
  ownerId: string,
): Promise<
  Array<{
    runId: string;
    seq: number;
    type: string;
    payload: unknown;
    ts: Date;
  }>
> {
  return db
    .select({
      runId: EntityRunEventTable.runId,
      seq: EntityRunEventTable.seq,
      type: EntityRunEventTable.type,
      payload: EntityRunEventTable.payload,
      ts: EntityRunEventTable.ts,
    })
    .from(EntityRunEventTable)
    .innerJoin(
      EntityRunTable,
      eq(EntityRunTable.id, EntityRunEventTable.runId),
    )
    .where(
      and(
        eq(EntityRunTable.threadId, threadId),
        eq(EntityRunTable.ownerId, ownerId),
        sql`${EntityRunEventTable.type} IN ('tool_call_chunk', 'tool_call_result')`,
      ),
    )
    .orderBy(asc(EntityRunEventTable.ts), asc(EntityRunEventTable.seq));
}

interface ExistingArtifactRef {
  artifactId: string;
  workflowId: string;
  workflowOutputField: string;
}

type TxHandle = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Idempotency lookup — works with the ambient `db` connection. */
async function findExistingArtifact(args: {
  ownerId: string;
  sourceThreadId: string;
  sourceOutcomeId: string;
}): Promise<ExistingArtifactRef | null> {
  return findExistingArtifactIn(db, args);
}

/** Idempotency lookup — works inside an open transaction. */
async function findExistingArtifactTx(
  tx: TxHandle,
  args: { ownerId: string; sourceThreadId: string; sourceOutcomeId: string },
): Promise<ExistingArtifactRef | null> {
  return findExistingArtifactIn(tx, args);
}

/** Shared implementation for both ambient and transactional lookups. */
async function findExistingArtifactIn(
  conn: typeof db | TxHandle,
  args: { ownerId: string; sourceThreadId: string; sourceOutcomeId: string },
): Promise<ExistingArtifactRef | null> {
  const rows = await conn
    .select({
      id: ArtifactTable.id,
      workflowId: ArtifactTable.workflowId,
      workflowOutputField: ArtifactTable.workflowOutputField,
    })
    .from(ArtifactTable)
    .where(
      and(
        eq(ArtifactTable.createdBy, args.ownerId),
        eq(ArtifactTable.sourceThreadId, args.sourceThreadId),
        eq(ArtifactTable.sourceOutcomeId, args.sourceOutcomeId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  if (row.workflowId === null || row.workflowOutputField === null) {
    return null;
  }
  return {
    artifactId: row.id,
    workflowId: row.workflowId,
    workflowOutputField: row.workflowOutputField,
  };
}

/**
 * Detect PostgreSQL unique-constraint violation (error code 23505).
 * Works with both `pg` driver errors and Drizzle-wrapped errors.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.code === "23505") return true;
  // Drizzle may wrap the driver error as `cause`.
  if (e.cause !== null && typeof e.cause === "object") {
    return (e.cause as Record<string, unknown>).code === "23505";
  }
  return false;
}

async function insertLineageEvent(
  tx: TxHandle,
  runId: string,
  report: SaveLineageReport,
): Promise<void> {
  const nextSeq = await pickNextEventSeq(tx, runId);
  await tx.insert(EntityRunEventTable).values({
    runId,
    seq: nextSeq,
    type: "save_lineage_emitted",
    payload: report as unknown as Record<string, unknown>,
  });
}

async function pickNextEventSeq(
  tx: TxHandle,
  runId: string,
): Promise<number> {
  // Pull MAX(seq) inside the transaction to avoid concurrent
  // writers colliding on (run_id, seq) PK. V1 runs are
  // single-writer per run so contention is theoretical.
  const rows = await tx
    .select({ maxSeq: sql<number | null>`MAX(${EntityRunEventTable.seq})` })
    .from(EntityRunEventTable)
    .where(eq(EntityRunEventTable.runId, runId));
  const max = rows[0]?.maxSeq;
  return max === null || max === undefined ? 0 : max + 1;
}

/**
 * Pick which key from `spec.outputs` becomes the artifact's
 * `workflow_output_field`. V1 strategy: take the first key.
 * `spec.outputs` is guaranteed non-empty by validate.ts.
 */
function pickWorkflowOutputField(spec: LLMWorkflowSpec): string {
  const keys = Object.keys(spec.outputs);
  if (keys.length === 0) {
    throw new WorkflowError({
      errorCode: "SPEC_NO_OUTPUTS",
      message: "Workflow spec has no outputs — cannot bind to an artifact.",
    });
  }
  return keys[0]!;
}

/** Map the artifact-creator tool name to an `ArtifactType`.
 *  Default falls through to "chart". New artifact-producing tools
 *  add a case here AND extend `ChartRendererSchema` (or a sibling)
 *  in `lib/workflows/spec/schema.ts` so the workflow spec recognises
 *  the corresponding node type. */
function deriveArtifactType(toolName: string): ArtifactType {
  switch (toolName) {
    case "generate_echarts_config":
      return "chart";
    case "render_html":
      return "html";
    case "render_markdown":
      return "report";
    default:
      return "chart";
  }
}

/**
 * Derive a human-readable artifact name. The frontend tool's args
 * often carry `title` / `name`; prefer those. Otherwise fall back
 * to the workflow's auto-name.
 */
function deriveArtifactName(
  spec: LLMWorkflowSpec,
  config: Record<string, unknown>,
): string {
  const title = readStringField(config, "title") ?? readStringField(config, "name");
  if (title !== undefined && title.length > 0) {
    return title.slice(0, 200);
  }
  return spec.name.slice(0, 200);
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}
