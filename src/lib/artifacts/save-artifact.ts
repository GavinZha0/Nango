/**
 * Save-artifact orchestrator — splits saving into two paths:
 *  - `chart` outcomes: extract & persist a backing Workflow + Artifact.
 *  - All other outcomes (`html`, `slide`, `image`, `a2ui`, `report`):
 *    persist a static `{ blocks }` snapshot with `workflowId = NULL`.
 *
 * Idempotent on `(source_thread_id, source_outcome_id)`.
 * See docs/artifact.md and docs/workflow.md.
 */

import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import {
  artifactTypeFromBlocks,
  type OutcomeBlock,
} from "@/lib/blocks/schema";
import { db } from "@/lib/db";
import {
  ArtifactTable,
  EntityRunEventTable,
  EntityRunTable,
  WorkflowTable,
} from "@/lib/db/schema";
import { ApiError } from "@/lib/http/route-handlers";
import { getTempMedia } from "@/lib/media/temp-media-cache";
import { logger as observabilityLogger } from "@/lib/observability/logger";
import { replayThreadOutcomes } from "@/lib/outcomes/replay-thread.server";
import { normalizeOutcomeId } from "@/lib/outcomes/schema";
import {
  buildWorkflowSpecFromRunEvents,
  canonicalize,
  type CanonicalizeDeps,
  type LLMWorkflowSpec,
  type SaveLineageReport,
  validate,
} from "@/lib/workflows";
import { WorkflowError } from "@/lib/workflows/error";
import type { Outcome } from "@/store/outcome-store";

import { coalesceToolCalls } from "./coalesce-tool-calls";
import { executeWorkflow } from "./execute-workflow";

const TOOL_IMAGE_PREFIX = "/api/media/tool-image/";
// SECURITY: Cap serialized static snapshot size to avoid unbounded jsonb rows.
const MAX_STATIC_SNAPSHOT_BYTES = 10 * 1024 * 1024;

// ─── Public surface ────────────────────────────────────────────────────

export interface SaveArtifactInput {
  ownerId: string;
  threadId: string;
  outcomeId: string;
  parentId?: string;
  name?: string;
  description?: string | null;
  revision?: string;
}

export interface SaveArtifactDeps {
  getToolMetadata: CanonicalizeDeps["getToolMetadata"];
  resolveAgentId: CanonicalizeDeps["resolveAgentId"];
  resolveDataSourceId: CanonicalizeDeps["resolveDataSourceId"];
}

export interface SaveArtifactResult {
  artifactId: string;
  /** `null` for static (workflow-less) artifacts. */
  workflowId: string | null;
  workflowOutputField: string | null;
  reused: boolean;
}

/** @deprecated Use `buildProductionSaveDeps(ownerId)` from `./save-deps.server.ts`. */
export const stubSaveDeps: SaveArtifactDeps = {
  getToolMetadata: async () => ({}),
  resolveAgentId: async () => null,
  resolveDataSourceId: async () => null,
};

// ─── Entry point ───────────────────────────────────────────────────────

export async function saveArtifact(
  input: SaveArtifactInput,
  deps: SaveArtifactDeps,
): Promise<SaveArtifactResult> {
  const existing = await findExistingArtifact({
    ownerId: input.ownerId,
    sourceThreadId: input.threadId,
    sourceOutcomeId: input.outcomeId,
  });

  if (
    existing !== null &&
    input.revision !== undefined &&
    existing.sourceRevision === input.revision
  ) {
    return {
      artifactId: existing.artifactId,
      workflowId: existing.workflowId,
      workflowOutputField: existing.workflowOutputField,
      reused: true,
    };
  }

  const replayed = await replayThreadOutcomes(
    input.threadId,
    input.ownerId,
    observabilityLogger,
  );
  const outcome =
    replayed.get(input.outcomeId) ??
    replayed.get(normalizeOutcomeId(input.outcomeId));

  // Non-chart outcomes are persisted as static `{ blocks }` snapshots without a workflow.
  if (outcome !== undefined && artifactTypeFromBlocks(outcome.blocks) !== "chart") {
    return saveStaticOutcomeArtifact(input, outcome, existing);
  }

  // Chart outcomes (and direct chart toolCallId saves) go through the workflow pipeline.
  return saveChartArtifact(input, existing, deps);
}

// ─── Static path (html / slide / image / a2ui / report) ────────────────

function materializeStaticBlocks(blocks: ReadonlyArray<OutcomeBlock>): OutcomeBlock[] {
  const materialized = blocks.map((block): OutcomeBlock => {
    if (block.kind !== "image" || !block.src.startsWith(TOOL_IMAGE_PREFIX)) {
      return block;
    }
    const mediaId = block.src.slice(TOOL_IMAGE_PREFIX.length);
    const media = getTempMedia(mediaId);
    if (!media) {
      throw new ApiError(
        "NOT_FOUND",
        404,
        "Image media has expired from temporary cache and cannot be saved.",
      );
    }
    const dataUrl = `data:${media.mimeType};base64,${media.buffer.toString("base64")}`;
    return {
      ...block,
      src: dataUrl,
      mimeType: media.mimeType,
    };
  });

  const bytes = Buffer.byteLength(JSON.stringify({ blocks: materialized }), "utf8");
  if (bytes > MAX_STATIC_SNAPSHOT_BYTES) {
    throw new ApiError(
      "VALIDATION_FAILED",
      413,
      `Artifact snapshot exceeds ${MAX_STATIC_SNAPSHOT_BYTES} byte limit.`,
    );
  }

  return materialized;
}

async function saveStaticOutcomeArtifact(
  input: SaveArtifactInput,
  outcome: Outcome,
  existing: ExistingArtifactRef | null,
): Promise<SaveArtifactResult> {
  const blocks = materializeStaticBlocks(outcome.blocks);
  const artifactType = artifactTypeFromBlocks(blocks);
  const snapshotPayload = { blocks };
  const revision = input.revision ?? outcome.revision;
  const now = new Date();

  const refresh = async (ref: ExistingArtifactRef): Promise<SaveArtifactResult> => {
    await db
      .update(ArtifactTable)
      .set({
        snapshot: snapshotPayload,
        snapshotAt: now,
        updatedAt: now,
        sourceRevision: revision,
      })
      .where(eq(ArtifactTable.id, ref.artifactId));
    return {
      artifactId: ref.artifactId,
      workflowId: null,
      workflowOutputField: null,
      reused: true,
    };
  };

  if (existing !== null) return refresh(existing);

  const name = (input.name?.trim() || outcome.title || "Untitled").slice(0, 200);
  const description =
    input.description !== undefined
      ? input.description
      : (outcome.description ?? null);

  try {
    const [inserted] = await db
      .insert(ArtifactTable)
      .values({
        kind: "artifact",
        type: artifactType,
        parentId: input.parentId ?? null,
        name,
        description,
        config: {},
        snapshot: snapshotPayload,
        snapshotAt: now,
        viewMode: "snapshot",
        createdBy: input.ownerId,
        sourceThreadId: input.threadId,
        sourceOutcomeId: input.outcomeId,
        sourceRevision: revision,
        workflowId: null,
        workflowOutputField: null,
      })
      .returning({ id: ArtifactTable.id });
    if (inserted === undefined) {
      throw new Error("saveStaticOutcomeArtifact: artifact insert returned no id.");
    }
    return {
      artifactId: inserted.id,
      workflowId: null,
      workflowOutputField: null,
      reused: false,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await findExistingArtifact({
        ownerId: input.ownerId,
        sourceThreadId: input.threadId,
        sourceOutcomeId: input.outcomeId,
      });
      if (winner !== null) return refresh(winner);
    }
    throw err;
  }
}

// ─── Chart workflow path ───────────────────────────────────────────────

async function saveChartArtifact(
  input: SaveArtifactInput,
  existing: ExistingArtifactRef | null,
  deps: SaveArtifactDeps,
): Promise<SaveArtifactResult> {
  const rawEvents = await loadThreadEvents(input.threadId, input.ownerId);
  const invocations = coalesceToolCalls(rawEvents);

  if (existing !== null) {
    if (invocations.length === 0) {
      return {
        artifactId: existing.artifactId,
        workflowId: existing.workflowId,
        workflowOutputField: existing.workflowOutputField,
        reused: true,
      };
    }
    const refreshed = await refreshChartArtifact({
      input,
      existing,
      rawEvents,
      invocations,
      deps,
    });
    if (refreshed !== null) return refreshed;
    return {
      artifactId: existing.artifactId,
      workflowId: existing.workflowId,
      workflowOutputField: existing.workflowOutputField,
      reused: true,
    };
  }

  const resolution = await resolveOutcomeToCall(
    {
      threadId: input.threadId,
      outcomeId: input.outcomeId,
      ownerId: input.ownerId,
    },
    rawEvents,
  );

  const built = buildWorkflowSpecFromRunEvents({
    invocations,
    artifactCreatingCallId: resolution.toolCallId,
  });

  const canonical = await canonicalize(built.spec, deps);
  validate(canonical);

  const workflowName = canonical.name;
  const workflowOutputField = pickWorkflowOutputField(built.spec);

  let result:
    | { artifactId: string; workflowId: string | null; reused: true }
    | { artifactId: string; workflowId: string; reused: false };
  try {
    const inserted = await db.transaction(async (tx) => {
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

      const creatorInv = invocations.find((i) => i.callId === resolution.toolCallId);
      const combinedConfig: Record<string, unknown> = {
        ...built.strippedFrontendConfig,
        ...(creatorInv?.result ? { result: creatorInv.result } : {}),
      };
      const initialSnapshot =
        combinedConfig.option && typeof combinedConfig.option === "object"
          ? combinedConfig.option
          : null;

      const [artifactRow] = await tx
        .insert(ArtifactTable)
        .values({
          kind: "artifact",
          type: "chart",
          name: input.name?.trim()?.length
            ? input.name.trim().slice(0, 200)
            : deriveArtifactName(built.spec, built.strippedFrontendConfig),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          sourceThreadId: input.threadId,
          sourceOutcomeId: input.outcomeId,
          ...(input.revision !== undefined && { sourceRevision: input.revision }),
          workflowId: workflowRow.id,
          workflowOutputField,
          viewMode: "snapshot",
          ...(initialSnapshot !== null
            ? { snapshot: initialSnapshot, snapshotAt: new Date() }
            : {}),
          config: combinedConfig,
          ...(input.parentId !== undefined && { parentId: input.parentId }),
          createdBy: input.ownerId,
        })
        .returning({ id: ArtifactTable.id });
      if (artifactRow === undefined) {
        throw new Error("saveArtifact: artifact row insert returned no id.");
      }

      await insertLineageEvent(tx, resolution.runId, built.lineageReport);

      return {
        artifactId: artifactRow.id,
        workflowId: workflowRow.id,
        reused: false as const,
      };
    });
    result = inserted;
  } catch (err) {
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

  await runWorkflowSnapshotBestEffort({
    artifactId: result.artifactId,
    workflowId: result.workflowId,
    spec: canonical,
    outputField: workflowOutputField,
    ownerId: input.ownerId,
  });

  return {
    artifactId: result.artifactId,
    workflowId: result.workflowId,
    workflowOutputField,
    reused: false,
  };
}

async function runWorkflowSnapshotBestEffort(args: {
  artifactId: string;
  workflowId: string;
  spec: Parameters<typeof executeWorkflow>[0]["spec"];
  outputField: string;
  ownerId: string;
}): Promise<void> {
  try {
    const resolution = await executeWorkflow({
      workflowId: args.workflowId,
      spec: args.spec,
      outputField: args.outputField,
      ownerId: args.ownerId,
      forceFresh: false,
    });
    if (resolution !== null && resolution.data !== undefined) {
      await db
        .update(ArtifactTable)
        .set({
          snapshot: resolution.data as Record<string, unknown>,
          snapshotAt: resolution.executedAt,
        })
        .where(eq(ArtifactTable.id, args.artifactId));
    }
  } catch (snapshotErr) {
    observabilityLogger.warn(
      {
        err: snapshotErr,
        artifactId: args.artifactId,
        workflowId: args.workflowId,
      },
      "workflow snapshot execution failed (non-fatal)",
    );
  }
}

async function refreshChartArtifact(args: {
  input: SaveArtifactInput;
  existing: ExistingArtifactRef;
  rawEvents: Awaited<ReturnType<typeof loadThreadEvents>>;
  invocations: ReturnType<typeof coalesceToolCalls>;
  deps: SaveArtifactDeps;
}): Promise<SaveArtifactResult | null> {
  const { input, existing, rawEvents, invocations, deps } = args;
  const resolution = await resolveOutcomeToCall(
    {
      threadId: input.threadId,
      outcomeId: input.outcomeId,
      ownerId: input.ownerId,
    },
    rawEvents,
  );
  const built = buildWorkflowSpecFromRunEvents({
    invocations,
    artifactCreatingCallId: resolution.toolCallId,
  });
  if (built.artifactCreatorToolName !== "generate_echarts_config") {
    return null;
  }

  const canonical = await canonicalize(built.spec, deps);
  validate(canonical);
  const workflowOutputField = pickWorkflowOutputField(built.spec);

  const creatorInv = invocations.find((i) => i.callId === resolution.toolCallId);
  const combinedConfig: Record<string, unknown> = {
    ...built.strippedFrontendConfig,
    ...(creatorInv?.result ? { result: creatorInv.result } : {}),
  };
  const refreshedSnapshot =
    combinedConfig.option && typeof combinedConfig.option === "object"
      ? combinedConfig.option
      : null;

  const now = new Date();
  await db.transaction(async (tx) => {
    if (existing.workflowId !== null) {
      await tx
        .update(WorkflowTable)
        .set({
          name: canonical.name,
          spec: canonical,
          updatedBy: input.ownerId,
          updatedAt: now,
        })
        .where(eq(WorkflowTable.id, existing.workflowId));
    }
    await tx
      .update(ArtifactTable)
      .set({
        config: combinedConfig,
        workflowOutputField,
        updatedAt: now,
        ...(refreshedSnapshot !== null
          ? { snapshot: refreshedSnapshot, snapshotAt: now }
          : {}),
        ...(input.revision !== undefined && { sourceRevision: input.revision }),
      })
      .where(eq(ArtifactTable.id, existing.artifactId));
  });

  if (existing.workflowId !== null) {
    await runWorkflowSnapshotBestEffort({
      artifactId: existing.artifactId,
      workflowId: existing.workflowId,
      spec: canonical,
      outputField: workflowOutputField,
      ownerId: input.ownerId,
    });
  }

  return {
    artifactId: existing.artifactId,
    workflowId: existing.workflowId,
    workflowOutputField,
    reused: true,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────

async function resolveOutcomeToCall(
  args: {
    threadId: string;
    outcomeId: string;
    ownerId: string;
  },
  preloadedEvents?: Array<{
    runId: string;
    seq: number;
    type: string;
    payload: unknown;
    ts: Date;
  }>,
): Promise<{ runId: string; toolCallId: string }> {
  const chunkRows =
    preloadedEvents ?? (await loadThreadEvents(args.threadId, args.ownerId));
  const invocations = coalesceToolCalls(chunkRows);

  const runIdByCall = new Map<string, string>();
  for (const row of chunkRows) {
    if (row.type !== "tool_call_chunk") continue;
    const p = row.payload;
    if (p === null || typeof p !== "object") continue;
    const id = (p as { toolCallId?: unknown }).toolCallId;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!runIdByCall.has(id)) runIdByCall.set(id, row.runId);
  }

  for (let i = invocations.length - 1; i >= 0; i--) {
    const inv = invocations[i]!;
    if (!inv.ok) continue;

    if (inv.callId === args.outcomeId) {
      const runId = runIdByCall.get(inv.callId);
      if (runId !== undefined) {
        return { runId, toolCallId: inv.callId };
      }
    }
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
    .orderBy(
      asc(EntityRunTable.createdAt),
      asc(EntityRunEventTable.seq),
      asc(EntityRunEventTable.ts),
    );
}

interface ExistingArtifactRef {
  artifactId: string;
  workflowId: string | null;
  workflowOutputField: string | null;
  sourceRevision: string | null;
}

type TxHandle = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function findExistingArtifact(args: {
  ownerId: string;
  sourceThreadId: string;
  sourceOutcomeId: string;
}): Promise<ExistingArtifactRef | null> {
  return findExistingArtifactIn(db, args);
}

async function findExistingArtifactTx(
  tx: TxHandle,
  args: { ownerId: string; sourceThreadId: string; sourceOutcomeId: string },
): Promise<ExistingArtifactRef | null> {
  return findExistingArtifactIn(tx, args);
}

async function findExistingArtifactIn(
  conn: typeof db | TxHandle,
  args: { ownerId: string; sourceThreadId: string; sourceOutcomeId: string },
): Promise<ExistingArtifactRef | null> {
  const rows = await conn
    .select({
      id: ArtifactTable.id,
      workflowId: ArtifactTable.workflowId,
      workflowOutputField: ArtifactTable.workflowOutputField,
      sourceRevision: ArtifactTable.sourceRevision,
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
  return {
    artifactId: row.id,
    workflowId: row.workflowId,
    workflowOutputField: row.workflowOutputField,
    sourceRevision: row.sourceRevision ?? null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.code === "23505") return true;
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
  const rows = await tx
    .select({ maxSeq: sql<number | null>`MAX(${EntityRunEventTable.seq})` })
    .from(EntityRunEventTable)
    .where(eq(EntityRunEventTable.runId, runId));
  const max = rows[0]?.maxSeq;
  return max === null || max === undefined ? 0 : max + 1;
}

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
