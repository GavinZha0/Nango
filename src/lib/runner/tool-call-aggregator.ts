/**
 * `aggregateToolCalls` — pair `tool_call_chunk` and `tool_call_result`
 * events across the entire thread by `toolCallId`, then group the
 * resulting aggregates by their owner run (the chunk-bearing run
 * wins; pure result-only aggregates fall back to their result run).
 *
 * Lives in its own module so the cross-run pairing rules are
 * unit-testable without the full DB / route stack.
 *
 * @see docs/runner-events.md §4.5 (continuation runs) and §4.6
 *      (cross-run tool-call resolution).
 */

import "server-only";

/** Single tool-call event row as read from `entity_run_event`.
 *  `type` is widened to `string` so this fits the raw drizzle select
 *  shape; non-tool-call rows are silently ignored. The caller is
 *  expected to filter to `tool_call_chunk` / `tool_call_result` for
 *  efficiency. */
export interface ToolEventRow {
  runId: string;
  seq: number;
  type: string;
  /** ISO string OR a Date — we re-stringify either way. */
  ts: string | Date;
  payload: unknown;
}

export interface ToolCallAggregate {
  toolCallId: string;
  toolName: string | null;
  /** Run where the LLM emitted the chunk (its decision). Owner of
   *  this row in the admin UI. null only for the rare result-only
   *  shape (no surviving chunk event — e.g. a bridged backend that
   *  emits results without prior chunks). */
  chunkRunId: string | null;
  /** seq within `chunkRunId` — used to order tool rows on the
   *  owning RunCard. Zero when `chunkRunId === null`. */
  chunkSeq: number;
  /** Run where the matching result landed. Equal to `chunkRunId` for
   *  normal server-side tools; differs for frontend / HITL tools
   *  where the user reply triggered a continuation run. null when
   *  the chunk never paired (true dangling — agent crashed, bridge
   *  dropped result, ...). */
  resultRunId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  resultContent: string | null;
}

function tsString(ts: string | Date): string {
  return typeof ts === "string" ? ts : ts.toISOString();
}

/** Cross-run pair-up. Returns one `ToolCallAggregate` per distinct
 *  `toolCallId` seen, regardless of which run each event lived in.
 *
 *  Input event order matters only for the first-seen-wins tie-breaks
 *  when the same toolCallId appears twice in the same role (chunk or
 *  result). Caller should pass events sorted by `ts` ascending. */
export function buildToolCallAggregates(
  events: ReadonlyArray<ToolEventRow>,
): Map<string, ToolCallAggregate> {
  const aggregates = new Map<string, ToolCallAggregate>();

  for (const ev of events) {
    // Filter type FIRST so a stray non-tool-call row never spawns
    // a bogus empty aggregate.
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
      // tool_call_result
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

/** Group aggregates by their owner run (chunk run > result run) and
 *  sort each run's list by `chunkSeq` so the order matches the event
 *  timeline of the owning run. */
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
      // chunk-bearing items sort by chunkSeq; result-only items
      // (chunkRunId === null) sort by startedAt. When the two
      // shapes mix (rare), chunk-bearing entries land first.
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
