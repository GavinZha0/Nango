import "server-only";

/**
 * Reverse-rebuild persisted `entity_run_event` rows into an AG-UI event
 * stream that CopilotKit's client can consume via the SSE `/connect`
 * endpoint.
 *
 * Used by {@link PersistedAgentRunner} when `connect()` is called for a
 * thread that has no active run in this process (i.e. the canonical
 * post-restart history-replay path). The in-memory GLOBAL_STORE that
 * CopilotKit's default `InMemoryAgentRunner` relies on is lost across
 * process restarts; this module is what makes history survive.
 *
 * Mapping (single DB row → 1..N AG-UI events):
 *  | row.type              | events                                                  |
 *  |-----------------------|---------------------------------------------------------|
 *  | message               | TEXT_MESSAGE_START + CONTENT + END                      |
 *  | tool_call_chunk       | TOOL_CALL_START + ARGS + END (+ synthetic RESULT if no  |
 *  |                       |   real tool_call_result row exists for the same call)   |
 *  | tool_call_result      | TOOL_CALL_RESULT                                        |
 *  | reasoning             | REASONING_START + MESSAGE_START + CONTENT + END + END   |
 *  | error                 | RUN_ERROR                                               |
 *  | started / final       | suppressed (we wrap each run with our own RUN_STARTED / |
 *  |                       |   RUN_FINISHED that omits `input` — see migration doc)  |
 *  | degraded   | suppressed (admin-only, not user-visible)               |
 *
 * The user's prompt is persisted as the first `message` event row of
 * each HTTP-dispatched run (see `runner.recordUserMessage`), so it
 * flows through the standard `case "message"` arm in
 * {@link eventRowToAgUi} with its original client-generated message id
 * intact. That id match lets CopilotKit's apply pipeline dedupe the
 * replayed user message against the client's local state, avoiding
 * the duplicate-user-prompt rendering on the post-finalize /connect.
 *
 * Runs that bypass HTTP (programmatic / scheduled dispatches) do NOT
 * persist a user-message row — their chat-style replay is admin-only
 * and intentionally omits the prompt here.
 *
 * Synthesis for missing TOOL_CALL_RESULT exists because AI SDK does not
 * emit `tool-result` parts for frontend tools (tools without an
 * `execute()` function). Those results are tracked by the CopilotKit
 * client locally during the live run; after restart that local state
 * is gone and the reconstructed stream is the only source. See
 * {@link synthesizeToolCallResult} for per-tool reconstruction rules.
 *
 * @see docs/persisted-agent-runner-migration.md
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { from, type Observable } from "rxjs";

import {
  EventType,
  type BaseEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
  type ReasoningEndEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type ReasoningStartEvent,
} from "@/lib/copilot/index.server";
import { db } from "@/lib/db";
import {
  EntityRunEventTable,
  EntityRunTable,
  type EntityRunEntity,
  type EntityRunEventEntity,
} from "@/lib/db/schema";
import type { childLogger } from "@/lib/observability/logger";

/** Caller-supplied inputs. `ownerId` scopes the DB query — never trust
 *  the threadId alone, always intersect with the requesting user. */
export interface ReconstructFromDbArgs {
  threadId: string;
  ownerId: string;
  log: ReturnType<typeof childLogger>;
}

/**
 * Public entry point. Lazy by construction — events are not produced
 * until a subscriber attaches to the returned Observable.
 */
export function reconstructFromDb(
  args: ReconstructFromDbArgs,
): Observable<BaseEvent> {
  return from(generateEvents(args));
}

// region: top-level traversal

async function* generateEvents(
  args: ReconstructFromDbArgs,
): AsyncIterable<BaseEvent> {
  const runs = await fetchRuns(args);
  if (runs.length === 0) return;

  const eventsByRun = await fetchEventsByRun(runs.map((r) => r.id));

  // Cross-run dedup for persisted `message` rows. CopilotKit's
  // frontend-tool flow turns one logical user turn into two
  // `entity_run` rows (run 1 emits the tool_call_chunk; run 2 is the
  // LLM continuation seeded with the same message body). The
  // continuation's `extractRunInput` reads the latest user message
  // from the request body, which is still the original prompt —
  // so `recordUserMessage` writes a `message` row at seq 0 of run 2
  // with the SAME client-generated `messageId` as run 1's. Without
  // dedup here, `/connect` replay surfaces that user prompt twice on
  // a cold client (Tab switch + come back is the canonical repro).
  //
  // We dedup at the row level, not at the AG-UI event level, because
  // a `message` row expands to TEXT_MESSAGE_START / CONTENT / END
  // and partial dedup would emit a half triplet.
  //
  // Scope: only rows with a non-empty `payload.messageId` participate.
  // Rows without one fall back to `${runId}.msg.${seq}` inside
  // `eventRowToAgUi`, which is uniquely keyed per run by construction
  // and therefore cannot collide.
  const seenMessageIds: Set<string> = new Set();

  for (const run of runs) {
    yield buildRunStarted(args.threadId, run.id);

    const events = eventsByRun.get(run.id) ?? [];
    const resolvedToolCallIds = collectResolvedToolCalls(events);

    // The user's prompt event row (if any) lives at seq 0 of HTTP-
    // dispatched runs; the per-row emitter handles it like any other
    // `message` event. No special pre-emit step required.

    for (const ev of events) {
      if (ev.type === "message") {
        const msgId = (ev.payload as { messageId?: unknown } | null | undefined)
          ?.messageId;
        if (typeof msgId === "string" && msgId.length > 0) {
          if (seenMessageIds.has(msgId)) continue;
          seenMessageIds.add(msgId);
        }
      }

      yield* eventRowToAgUi(ev, run.id);

      // CONTRACT: synthetic TOOL_CALL_RESULT goes immediately after the
      // chunk's TOOL_CALL_END. If the chunk has a real result later in
      // this run's event stream, we skip synthesis and let the real row
      // emit naturally. Synthetic results inherit the chunk row's `ts`
      // as their timestamp — that's also the TOOL_CALL_END ts — so a
      // frontend tool whose result row was never persisted still
      // surfaces a duration of (TOOL_CALL_START.ts → TOOL_CALL_END.ts)
      // instead of zero. Same row, same ts → duration = 0ms today, but
      // it leaves the door open for a future improvement that uses
      // the next event's ts as a "no later than" upper bound.
      if (ev.type === "tool_call_chunk") {
        const payload = ev.payload as
          | { toolCallId?: string; toolName?: string; args?: string }
          | null
          | undefined;
        const toolCallId = payload?.toolCallId;
        if (toolCallId && !resolvedToolCallIds.has(toolCallId)) {
          yield synthesizeToolCallResult(
            {
              toolCallId,
              toolName: payload?.toolName ?? "unknown",
              args: payload?.args ?? "",
            },
            run.status,
            ev.ts.getTime(),
          );
        }
      }
    }

    yield buildRunFinished(args.threadId, run.id);
  }
}

// endregion

// region: DB queries

async function fetchRuns(
  args: ReconstructFromDbArgs,
): Promise<EntityRunEntity[]> {
  return db
    .select()
    .from(EntityRunTable)
    .where(
      and(
        eq(EntityRunTable.threadId, args.threadId),
        eq(EntityRunTable.ownerId, args.ownerId),
        // Exclude supervisor sub-runs (parent_run_id IS NULL == root run
        // in the same thread). Aligns with /api/threads/[id]/messages.
        isNull(EntityRunTable.parentRunId),
        // CONTRACT: only replay terminal-state runs. If `/connect`
        // fires while a run is still in flight (e.g. the post-finalize
        // re-fire from `CopilotChat.useEffect` lands during the LLM
        // continuation /run that follows a frontend-tool turn), the
        // live `/run` SSE response is already the canonical event
        // source for that run. Emitting a half-persisted replay would
        // race against it and either prematurely close the run
        // (RUN_FINISHED on the still-running row) or miss its
        // in-flight events (PersistingAgent flushes at boundaries,
        // not per delta).
        inArray(EntityRunTable.status, [
          "succeeded",
          "failed",
          "cancelled",
        ]),
      ),
    )
    .orderBy(
      asc(EntityRunTable.startedAt),
      asc(EntityRunTable.createdAt),
    );
}

async function fetchEventsByRun(
  runIds: string[],
): Promise<Map<string, EntityRunEventEntity[]>> {
  if (runIds.length === 0) return new Map();
  const events = await db
    .select()
    .from(EntityRunEventTable)
    .where(inArray(EntityRunEventTable.runId, runIds))
    .orderBy(asc(EntityRunEventTable.runId), asc(EntityRunEventTable.seq));

  const grouped = new Map<string, EntityRunEventEntity[]>();
  for (const ev of events) {
    const list = grouped.get(ev.runId);
    if (list) list.push(ev);
    else grouped.set(ev.runId, [ev]);
  }
  return grouped;
}

function collectResolvedToolCalls(
  events: EntityRunEventEntity[],
): Set<string> {
  const resolved = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "tool_call_result") continue;
    const tcid = (ev.payload as { toolCallId?: string } | null | undefined)
      ?.toolCallId;
    if (tcid) resolved.add(tcid);
  }
  return resolved;
}

// endregion

// region: per-row emitter

function* eventRowToAgUi(
  ev: EntityRunEventEntity,
  runId: string,
): Iterable<BaseEvent> {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "message": {
      const messageId =
        readString(p.messageId) ?? `${runId}.msg.${ev.seq}`;
      const role = readMessageRole(p.role);
      const text = readString(p.text) ?? "";
      yield buildTextStart(messageId, role);
      if (text.length > 0) yield buildTextContent(messageId, text);
      yield buildTextEnd(messageId);
      return;
    }
    case "tool_call_chunk": {
      const toolCallId = readString(p.toolCallId);
      if (!toolCallId) return;
      const toolCallName = readString(p.toolName) ?? "unknown";
      const args = readString(p.args) ?? "";
      // CONTRACT: all three derived events share the chunk row's
      // wall-clock `ts`. Downstream consumers (`useElapsedSeconds`
      // via AG-UI `AgentSubscriber.onToolCall*Event`) read
      // `event.timestamp` to recover real durations on history
      // replay, where Date.now() would collapse start ≈ end to 0s.
      // `tool_call_end`'s timestamp is also the synthetic-result
      // fallback (see synthesizeToolCallResult below).
      const ts = ev.ts.getTime();
      yield buildToolStart(toolCallId, toolCallName, ts);
      if (args.length > 0) yield buildToolArgs(toolCallId, args, ts);
      yield buildToolEnd(toolCallId, ts);
      return;
    }
    case "tool_call_result": {
      const toolCallId = readString(p.toolCallId);
      if (!toolCallId) return;
      const content = readString(p.content) ?? JSON.stringify(null);
      yield buildToolResult(
        toolCallId,
        content,
        `${runId}.tool.${ev.seq}`,
        ev.ts.getTime(),
      );
      return;
    }
    case "reasoning": {
      const messageId =
        readString(p.messageId) ?? `${runId}.reasoning.${ev.seq}`;
      const text = (readString(p.text) ?? "").trim();
      if (text.length === 0) return;
      yield buildReasoningStart(messageId);
      yield buildReasoningMessageStart(messageId);
      yield buildReasoningMessageContent(messageId, text);
      yield buildReasoningMessageEnd(messageId);
      yield buildReasoningEnd(messageId);
      return;
    }
    case "error": {
      yield buildRunError(readString(p.message) ?? "Run errored");
      return;
    }
    // started / finished / degraded: suppressed. Each run
    // is wrapped by our own RUN_STARTED / RUN_FINISHED at the outer
    // loop.
    case "started":
    case "finished":
    case "degraded":
    default:
      return;
  }
}

// endregion

// region: synthesis

/**
 * Build a synthetic TOOL_CALL_RESULT for a tool_call_chunk row that has
 * no matching tool_call_result row in DB.
 *
 * **Why `isError: true` for a synthetic placeholder?** Synthetic
 * results signal a protocol/system-layer anomaly ("we don't have a
 * real tool result"), not a business outcome. We tag the envelope
 * with `isError: true` so detect-tool-result-status classifies it
 * away from the success path; the `severity` field then disambiguates
 * the two anomaly flavours:
 *
 *   - `severity: "warning"` — missing result for a still-successful
 *     run. The UI shows an amber/yellow "Warning" badge so users see
 *     "we lost the result, the run may still have succeeded".
 *   - `severity: "error"` (or omitted) — the run itself failed before
 *     the tool completed. The UI shows a red "Error" badge.
 *
 * **When to add a per-tool case here**: only when the tool's result
 * envelope carries an identifier the LLM references in subsequent
 * turns (e.g. generate_echarts_config's chart_id — "update the
 * sales-pie chart"). The vast majority of tools are "fire-and-forget"
 * from the LLM's perspective and the generic warning envelope is
 * enough.
 *
 * For non-succeeded runs we always synthesize a failure envelope so
 * the LLM sees the call as "completed but failed", not "still
 * pending" — that prevents CopilotKit's auto-recovery from re-running
 * the handler on history replay.
 */
export function synthesizeToolCallResult(
  payload: { toolCallId: string; toolName: string; args: string },
  runStatus: string,
  timestamp?: number,
): ToolCallResultEvent {
  if (runStatus !== "succeeded") {
    return buildSyntheticResult(
      payload.toolCallId,
      JSON.stringify({
        isError: true,
        severity: "error",
        message: "Run aborted before this tool completed.",
      }),
      timestamp,
    );
  }
  // Per-tool placeholder enrichments. Chart id propagation is the
  // only one today: lets the LLM say "update the sales-pie chart"
  // on a follow-up turn without re-deriving the id from history.
  let extra: Record<string, unknown> = {};
  if (payload.toolName === "generate_echarts_config") {
    try {
      const args = JSON.parse(payload.args) as { chart_id?: unknown };
      if (typeof args.chart_id === "string" && args.chart_id.length > 0) {
        extra = { chart_id: args.chart_id };
      }
    } catch {
      /* fall through with empty extra */
    }
  }
  return buildSyntheticResult(
    payload.toolCallId,
    JSON.stringify({
      isError: true,
      severity: "warning",
      message: "No tool result was recorded — outcome inferred.",
      ...extra,
    }),
    timestamp,
  );
}

// endregion

// region: typed event constructors
// Wrapping object literals in factory functions keeps the call sites
// terse and lets `tsc` enforce the schema field requirements without
// `as BaseEvent` casts.

function buildRunStarted(threadId: string, runId: string): RunStartedEvent {
  // INTENTIONAL: omit `input`. CopilotKit's `compactEvents` consumes
  // `input.messages` for cross-run dedup; on DB replay the rows are
  // already the canonical timeline, we want no dedup at all.
  return { type: EventType.RUN_STARTED, threadId, runId };
}

function buildRunFinished(
  threadId: string,
  runId: string,
): RunFinishedEvent {
  return { type: EventType.RUN_FINISHED, threadId, runId };
}

function buildTextStart(
  messageId: string,
  role: TextMessageRole,
): TextMessageStartEvent {
  return { type: EventType.TEXT_MESSAGE_START, messageId, role };
}

function buildTextContent(
  messageId: string,
  delta: string,
): TextMessageContentEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta };
}

function buildTextEnd(messageId: string): TextMessageEndEvent {
  return { type: EventType.TEXT_MESSAGE_END, messageId };
}

function buildToolStart(
  toolCallId: string,
  toolCallName: string,
  timestamp?: number,
): ToolCallStartEvent {
  // `timestamp` is the AG-UI BaseEvent optional field (unix ms). Set
  // from the persisted event row's `ts` so client-side timing
  // (`useElapsedSeconds` via `agent.subscribe(...)`) recovers the real
  // wall-clock duration on history replay. Same applies to all four
  // tool-* builders below. Omitted when caller passes undefined so we
  // don't lie about timing for live (non-replay) emitters.
  return withTs({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName }, timestamp);
}

function buildToolArgs(
  toolCallId: string,
  delta: string,
  timestamp?: number,
): ToolCallArgsEvent {
  return withTs({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta }, timestamp);
}

function buildToolEnd(
  toolCallId: string,
  timestamp?: number,
): ToolCallEndEvent {
  return withTs({ type: EventType.TOOL_CALL_END, toolCallId }, timestamp);
}

function buildToolResult(
  toolCallId: string,
  content: string,
  messageId: string,
  timestamp?: number,
): ToolCallResultEvent {
  return withTs(
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      content,
      role: "tool",
      messageId,
    },
    timestamp,
  );
}

function buildSyntheticResult(
  toolCallId: string,
  content: string,
  timestamp?: number,
): ToolCallResultEvent {
  return buildToolResult(toolCallId, content, `synth.${toolCallId}`, timestamp);
}

/** Spread `timestamp` into the event only when defined. AG-UI's
 *  BaseEventSchema declares `timestamp: z.ZodOptional<z.ZodNumber>`,
 *  so emitting `timestamp: undefined` is wire-equivalent to omitting
 *  the field, but Zod's strict modes complain about the explicit
 *  undefined. This helper keeps the call sites declarative. */
function withTs<T extends BaseEvent>(event: T, timestamp: number | undefined): T {
  return timestamp === undefined ? event : { ...event, timestamp };
}

function buildReasoningStart(messageId: string): ReasoningStartEvent {
  return { type: EventType.REASONING_START, messageId };
}

function buildReasoningEnd(messageId: string): ReasoningEndEvent {
  return { type: EventType.REASONING_END, messageId };
}

function buildReasoningMessageStart(
  messageId: string,
): ReasoningMessageStartEvent {
  return {
    type: EventType.REASONING_MESSAGE_START,
    messageId,
    role: "reasoning",
  };
}

function buildReasoningMessageContent(
  messageId: string,
  delta: string,
): ReasoningMessageContentEvent {
  return { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta };
}

function buildReasoningMessageEnd(
  messageId: string,
): ReasoningMessageEndEvent {
  return { type: EventType.REASONING_MESSAGE_END, messageId };
}

function buildRunError(message: string): RunErrorEvent {
  // `code` is optional in the AG-UI schema; we tag with a constant so
  // downstream consumers can distinguish DB-replay errors from
  // live-run errors if they ever care.
  return { type: EventType.RUN_ERROR, message, code: "DB_REPLAY" };
}

// endregion

// region: payload field readers
// AG-UI events come back from DB as `jsonb`; the runtime types are
// loose. These readers are total — they always return either a valid
// value of the expected type or the safe fallback.

type TextMessageRole = "developer" | "system" | "assistant" | "user";

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readMessageRole(value: unknown): TextMessageRole {
  if (
    value === "developer" ||
    value === "system" ||
    value === "user" ||
    value === "assistant"
  ) {
    return value;
  }
  return "assistant";
}

// endregion
