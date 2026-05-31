/**
 * Pair `tool_call_chunk` + `tool_call_result` events across a thread
 * by `toolCallId`, then group aggregates by their owner run (chunk
 * run wins; result-only falls back to result run).
 *
 * See docs/runner-events.md.
 */

import "server-only";

/** Single tool-call event row as read from `entity_run_event`. The
 *  caller is expected to filter to `tool_call_chunk` /
 *  `tool_call_result` for efficiency. */
export interface ToolEventRow {
  runId: string;
  seq: number;
  type: string;
  ts: string | Date;
  payload: unknown;
}

export interface ToolCallAggregate {
  toolCallId: string;
  toolName: string | null;
  /** Run where the LLM emitted the chunk (owner in the admin UI).
   *  null for result-only shapes (rare; e.g. a bridge emitting
   *  results without prior chunks). */
  chunkRunId: string | null;
  /** seq within `chunkRunId`, used to order tool rows on the owning
   *  RunCard. Zero when `chunkRunId === null`. */
  chunkSeq: number;
  /** Run where the matching result landed. Equal to `chunkRunId` for
   *  server-side tools; differs for frontend / HITL where the user
   *  reply triggered a continuation run. null when never paired. */
  resultRunId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  resultContent: string | null;
}

function tsString(ts: string | Date): string {
  return typeof ts === "string" ? ts : ts.toISOString();
}

/** Cross-run pair-up. One aggregate per distinct `toolCallId`.
 *  CONTRACT: caller passes events sorted by `ts` ascending — order
 *  affects first-seen-wins tie-breaks. */
export function buildToolCallAggregates(
  events: ReadonlyArray<ToolEventRow>,
): Map<string, ToolCallAggregate> {
  const aggregates = new Map<string, ToolCallAggregate>();

  for (const ev of events) {
    if (ev.type !== "tool_call_chunk" && ev.type !== "tool_call_result") {
      continue;
    }
    const payload = ev.payload as
      | {
          toolCallId?: unknown;
          toolName?: unknown;
          content?: unknown;
        }
      | null;
    if (!payload || typeof payload.toolCallId !== "string") continue;
    const toolCallId = payload.toolCallId;

    let agg = aggregates.get(toolCallId);
    if (!agg) {
      agg = {
        toolCallId,
        toolName: null,
        chunkRunId: null,
        chunkSeq: 0,
        resultRunId: null,
        startedAt: null,
        endedAt: null,
        resultContent: null,
      };
      aggregates.set(toolCallId, agg);
    }

    const ts = tsString(ev.ts);
    if (ev.type === "tool_call_chunk") {
      if (agg.chunkRunId === null) {
        agg.chunkRunId = ev.runId;
        agg.chunkSeq = ev.seq;
        agg.startedAt = ts;
      }
      if (agg.toolName === null && typeof payload.toolName === "string") {
        agg.toolName = payload.toolName;
      }
    } else {
      if (agg.resultRunId === null) {
        agg.resultRunId = ev.runId;
        agg.endedAt = ts;
      }
      if (typeof payload.content === "string") {
        agg.resultContent = payload.content;
      }
    }
  }

  return aggregates;
}

/** Group aggregates by owner run (chunk > result) and sort each
 *  list by `chunkSeq` to match the owning run's event timeline. */
export function groupAggregatesByOwnerRun(
  aggregates: Iterable<ToolCallAggregate>,
): Map<string, ToolCallAggregate[]> {
  const byRun = new Map<string, ToolCallAggregate[]>();
  for (const agg of aggregates) {
    const ownerRunId = agg.chunkRunId ?? agg.resultRunId;
    if (!ownerRunId) continue;
    let arr = byRun.get(ownerRunId);
    if (!arr) {
      arr = [];
      byRun.set(ownerRunId, arr);
    }
    arr.push(agg);
  }
  for (const arr of byRun.values()) {
    arr.sort((a, b) => {
      // chunk-bearing → chunkSeq; result-only → startedAt; mixed → chunk-bearing first.
      if (a.chunkRunId !== null && b.chunkRunId !== null) {
        return a.chunkSeq - b.chunkSeq;
      }
      if (a.chunkRunId === null && b.chunkRunId === null) {
        return (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
      }
      return a.chunkRunId !== null ? -1 : 1;
    });
  }
  return byRun;
}

/** Convenience: build + group in one call. */
export function aggregateToolCalls(
  events: ReadonlyArray<ToolEventRow>,
): Map<string, ToolCallAggregate[]> {
  return groupAggregatesByOwnerRun(buildToolCallAggregates(events).values());
}
