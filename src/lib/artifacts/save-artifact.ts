/**
 * Save-artifact orchestrator — the impure I/O layer on top of
 * the W1.5 pure pipeline (§10.1.2 C-pattern split).
 *
 * One call to `saveArtifact()` does:
 *
 *   1. Load the source `entity_run` events from the DB
 *   2. Coalesce raw `tool_call_chunk` + `tool_call_result` event
 *      pairs into `ToolInvocation[]`
 *   3. Call `buildWorkflowSpecFromRunEvents()` (W1.5) — pure
 *      extraction → LLM-emit spec + strippedFrontendConfig +
 *      lineageReport
 *   4. Call `canonicalize()` (W1.3) → canonical spec
 *   5. Call `validate()` (W1.3) — throws WorkflowError on
 *      structural failure
 *   6. Open a DB transaction:
 *        - INSERT workflow row (spec JSONB)
 *        - INSERT artifact row (content=strippedFrontendConfig,
 *          workflow_id=<new>, workflow_output_field=<picked>)
 *        - INSERT entity_run_event (`save_lineage_emitted`)
 *      Atomic — partial failure rolls everything back.
 *   7. Return `{ artifactId, workflowId, workflowOutputField }`
 *
 * Idempotency (§10.1 / artifact-table comment): the artifact row
 * carries `(source_thread_id, source_outcome_id)`; clicking Save
 * twice on the same outcome returns the existing ids rather than
 * creating duplicates.
 *
 * V1 simplification: `getToolMetadata` and `resolveAgentId` deps
 * are injected here — the route handler wires them to the actual
 * tool registry / EntityCatalog. Stubs that return empty metadata
 * are acceptable for tool-only workflows; agent nodes will fail
 * canonicalization unless resolveAgentId returns a real UUID.
 *
 * D31 — this file lives under `src/lib/artifacts/` because the
 * user-facing operation is "save an artifact". The workflow
 * extraction is an implementation detail.
 */

import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

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
import {
  chartArgsToContent,
  readRenderChartArgs,
} from "@/lib/outcomes/args-to-content";
import type { ArtifactType } from "@/lib/domain/artifact";

import { coalesceToolCalls } from "./coalesce-tool-calls";

// ─── Public surface ────────────────────────────────────────────────────

export interface SaveArtifactInput {
  /** Caller user id — owner of the new artifact + workflow rows. */
  ownerId: string;
  /**
   * Chat thread the outcome belongs to. Used both for idempotency
   * (`source_thread_id` column) and for scoping the cross-run
   * event search that resolves `outcomeId` to a concrete
   * `(runId, toolCallId)`.
   */
  threadId: string;
  /**
   * The outcome's stable id from the frontend (`Outcome.outcomeId`).
   * For `render_chart` outcomes this is the LLM-chosen `chartId`
   * (see `useOutcomeTools.tsx`); for future frontend tools it
   * stays the producer-chosen stable identifier. The orchestrator
   * resolves this to the underlying tool call by scanning the
   * thread's `tool_call_chunk` events for one whose args carry
   * the same id.
   */
  outcomeId: string;
  /**
   * Optional explicit folder for the new artifact. The
   * `SaveOutcomeDialog` always supplies one (its
   * `ArtifactFolderTreeSelect` defaults to the seed category
   * matching the outcome's kind). When omitted at the API level,
   * the artifact lands at the root of the user's tree — V1
   * intentionally does NOT auto-route from `saveArtifact` to a
   * seed category, because the dialog already covers that path
   * and the orchestrator avoids extra DB roundtrips. Programmatic
   * callers that want auto-routing should resolve the parentId
   * themselves before calling.
   */
  parentId?: string;
  /**
   * Optional human-readable name override. Used by the
   * SaveOutcomeDialog to let the user retitle before saving.
   * When omitted, `deriveArtifactName()` picks from the spec
   * config (frontend `title` / `name` field) or falls back to
   * the auto-generated workflow name.
   */
  name?: string;
  /**
   * Optional user description for the artifact. Stored verbatim
   * on the row's `description` column.
   */
  description?: string | null;
}

export interface SaveArtifactDeps {
  /** Tool-registry view; passed through to canonicalize. */
  getToolMetadata: CanonicalizeDeps["getToolMetadata"];
  /** EntityCatalog view; passed through to canonicalize. */
  resolveAgentId: CanonicalizeDeps["resolveAgentId"];
}

export interface SaveArtifactResult {
  artifactId: string;
  workflowId: string;
  workflowOutputField: string;
  /** True if an existing artifact was returned (idempotent save). */
  reused: boolean;
}

/**
 * Production wiring for `SaveArtifactDeps`. Exported for the route
 * handler. The two lookups are intentionally stubbed in W1.6.x:
 *
 *   - `getToolMetadata` returns an empty `ToolMetadata`. This lets
 *     canonicalize succeed for tool-only workflows; downstream
 *     spec.input/output_schema validation simply lacks registry-
 *     declared shapes (it falls through to D19 sources 2/3).
 *   - `resolveAgentId` returns `null`. Agents in the spec will
 *     fail canonicalize with `AGENT_NOT_FOUND`, surfacing as a
 *     401-shaped `WorkflowError` to the LLM caller. Workflows
 *     captured from tool-only chats save fine.
 *
 * W1.7 swaps both stubs for the real tool registry view +
 * EntityCatalog lookup. The shape of these calls is intentionally
 * pinned now so the swap is a single import change.
 */
export const productionSaveDeps: SaveArtifactDeps = {
  getToolMetadata: () => ({}),
  resolveAgentId: () => null,
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
  // 1. Idempotency check first — cheap row-by-row lookup. If a
  //    matching artifact already exists for this user, return its
  //    ids without re-walking events.
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

  // 2. Resolve outcomeId → (runId, toolCallId).
  //    The outcome's id (frontend's `chartId` for render_chart) is
  //    embedded in a `tool_call_chunk` event's args somewhere in
  //    the thread; the chunk also carries the underlying OpenAI
  //    `toolCallId` we need to identify the artifact creator.
  const resolution = await resolveOutcomeToCall({
    threadId: input.threadId,
    outcomeId: input.outcomeId,
    ownerId: input.ownerId,
  });

  // 3. Load + coalesce events across EVERY run in the thread.
  //    Chat tool calls routinely span multiple runs: turn N emits
  //    the `tool_call_chunk` (args) + `tool_call_result` (output)
  //    pair, then turn N+1 (e.g. the user's "Save" click) replays
  //    the same tool history into the LLM and re-emits matching
  //    `tool_call_result` events with no chunks. We need the full
  //    cross-run picture so the artifact creator's dependencies
  //    are recovered even when args + result live in different runs.
  //    The coalescer's per-toolCallId run pinning (see RawRunEvent)
  //    prevents arg double-concatenation from replay.
  const rawEvents = await loadThreadEvents(input.threadId, input.ownerId);
  const invocations = coalesceToolCalls(rawEvents);

  // 4. Pure pipeline: events → LLM spec + lineage.
  const built = buildWorkflowSpecFromRunEvents({
    invocations,
    artifactCreatingCallId: resolution.toolCallId,
  });

  // 4. Canonicalize (fills `type` tag, agentId, registry schemas).
  const canonical = canonicalize(built.spec, deps);

  // 5. Validate (DAG, cycles, ref reachability, top-level outputs).
  validate(canonical);

  // 6. Atomic persistence.
  const workflowName = canonical.name;
  const workflowOutputField = pickWorkflowOutputField(built.spec);
  const result = await db.transaction(async (tx) => {
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

    // Project the artifact creator's raw args into the renderable
    // block model (`{ blocks: OutcomeBlock[] }`) that
    // `ArtifactDetail.tsx` + `BlockList` consume. The per-tool
    // adapters live in `lib/outcomes/args-to-content.ts` and are
    // shared with live replay (`/api/threads/[id]/outcomes`) so
    // both surfaces project the same shape into the renderer.
    const content = artifactCreatorArgsToContent(
      built.artifactCreatorToolName,
      built.strippedFrontendConfig,
    );

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
        content,
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

    // Lineage telemetry — single event, source-of-truth for V2 analysis
    // and admin run forensics (§7.10.5).
    await insertLineageEvent(tx, resolution.runId, built.lineageReport);

    return { artifactId: artifactRow.id, workflowId: workflowRow.id };
  });

  return {
    artifactId: result.artifactId,
    workflowId: result.workflowId,
    workflowOutputField,
    reused: false,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────

/**
 * Resolve a frontend outcomeId to the (runId, toolCallId) pair
 * that originally produced it.
 *
 * The frontend-side `Outcome.outcomeId` is producer-chosen and
 * NOT the OpenAI `toolCallId`:
 *   - `render_chart`: outcomeId is the LLM-supplied `chartId`
 *     argument (a stable kebab-case slug). See
 *     `lib/outcomes/replay-rebuilders.ts::rebuildChartOutcome`.
 *   - `web_search`: outcomeId IS the toolCallId itself. See
 *     `rebuildWebSearchOutcome`.
 *
 * Resolution strategy:
 *   1. Scan every `tool_call_chunk` in the thread that the caller
 *      owns. Coalesce them per toolCallId so concatenated args
 *      parse correctly.
 *   2. Match against either `toolCallId === outcomeId` (covers
 *      web_search) or any string-valued field in the parsed args
 *      whose value equals `outcomeId` (covers render_chart's
 *      `chartId` and any future tool that embeds the outcome id
 *      in its args).
 *   3. Return the runId + toolCallId of the FIRST match in
 *      chronological order. Subsequent matches (replay in later
 *      turns) are ignored — see `coalesceToolCalls` for the
 *      run-pinning rule that makes that safe.
 *
 * Throws `WorkflowError` (code `UNKNOWN_ERROR`) if no match exists.
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

  // Coalesce the chunks so multi-chunk args (Vercel AI SDK streams
  // args incrementally) end up as a single parseable object.
  // We pass runId on each event so the coalescer pins each
  // toolCallId to its origin run and ignores replayed chunks.
  const invocations = coalesceToolCalls(chunkRows);

  // We need to know which run owns each invocation. Re-derive from
  // the chunk rows since `ToolInvocation` doesn't carry runId.
  // Map by toolCallId — first chunk in chronological order wins.
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
    // Producer-chosen ids embedded in args (chartId, …). Match any
    // top-level string value equal to outcomeId.
    for (const value of Object.values(inv.input)) {
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
 * Load every `tool_call_chunk` and `tool_call_result` row across
 * all runs in the thread the caller owns. Ordered by (ts, seq)
 * so chunks naturally precede their own results in the coalescer
 * (and chunks from earlier runs precede replayed result events in
 * later runs).
 *
 * Each row carries its `runId` so `coalesceToolCalls` can pin a
 * toolCallId to its origin run and ignore replayed chunks.
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

async function findExistingArtifact(args: {
  ownerId: string;
  sourceThreadId: string;
  sourceOutcomeId: string;
}): Promise<ExistingArtifactRef | null> {
  const rows = await db
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
    // Existing artifact wasn't created via save-as-workflow. Treat
    // as "no idempotent match" — the user is re-saving from a
    // different outcome but the chat happened to overlap.
    return null;
  }
  return {
    artifactId: row.id,
    workflowId: row.workflowId,
    workflowOutputField: row.workflowOutputField,
  };
}

async function insertLineageEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  runId: string,
): Promise<number> {
  // Pull MAX(seq) inside the transaction to avoid concurrent writers
  // colliding on (run_id, seq) PK. V1 runs are single-writer per
  // run so contention is theoretical, but the cost of being safe is
  // one extra round-trip.
  const rows = await tx
    .select({ maxSeq: sql<number | null>`MAX(${EntityRunEventTable.seq})` })
    .from(EntityRunEventTable)
    .where(eq(EntityRunEventTable.runId, runId));
  const max = rows[0]?.maxSeq;
  return max === null || max === undefined ? 0 : max + 1;
}

/**
 * Pick which key from `spec.outputs` becomes the artifact's
 * `workflow_output_field`. The artifact will resolve
 * `spec.outputs[field]` at render time (§4.5). V1 strategy: take
 * the first key. Spec.outputs is guaranteed non-empty by validate.ts.
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

/**
 * Derive the artifact's `type` (folder + render-routing tag) from
 * the artifact-creator's frontend tool name.
 *
 *   render_chart      → chart
 *   render_html       → html
 *   render_markdown   → report   (V1 ArtifactType has no "markdown"
 *                                  — long-form text goes under report)
 *
 * Falls back to "chart" — the V1 dominant case. Adding a new
 * frontend tool means adding a branch here AND a matching
 * `xxxArgsToContent` adapter in
 * `lib/outcomes/args-to-content.ts` (plus updating
 * `artifactCreatorArgsToContent` below).
 */
function deriveArtifactType(toolName: string): ArtifactType {
  switch (toolName) {
    case "render_chart":
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
 * Project the artifact-creator's raw args into the renderable
 * `{ blocks: OutcomeBlock[] }` shape stored in `artifact.content`
 * and consumed by `ArtifactDetail.tsx` → `<BlockList>`.
 *
 * V1 dispatches on `render_chart` only; other frontend tools
 * (`render_html`, `render_markdown`) are not yet implemented in
 * the chat UI, so they have no save path. The fallback path
 * preserves the raw args under a `__rawArgs` key so admin
 * forensics can recover them, but the renderer will still hit its
 * "unsupported format" placeholder — which is correct for a tool
 * the renderer doesn't know about.
 */
function artifactCreatorArgsToContent(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "render_chart") {
    const parsed = readRenderChartArgs(args);
    if (parsed === null) {
      throw new WorkflowError({
        errorCode: "UNKNOWN_ERROR",
        message:
          "Artifact creator's args do not satisfy the render_chart shape " +
          "(chartId + title required).",
      });
    }
    const content = chartArgsToContent(parsed);
    if (content === null) {
      throw new WorkflowError({
        errorCode: "UNKNOWN_ERROR",
        message:
          `render_chart args have no usable ECharts option (chartId=${parsed.chartId}).`,
      });
    }
    return content;
  }
  // Unknown frontend tool — passthrough so the row exists, but the
  // renderer will show the "unsupported format" placeholder.
  return { __rawArgs: args, __tool: toolName };
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
