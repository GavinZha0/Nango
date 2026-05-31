/**
 * Per-tool replay rebuilders for the `/api/threads/[id]/outcomes`
 * route. Each function takes the persisted event payload(s) for one
 * tool invocation and produces an `Outcome` — the same shape the
 * client-side write path produces, so replay and live emission
 * converge on the same row via `outcomeStore.addOutcome`'s upsert.
 *
 * The rebuilders are pure (no DB, no logger reach-through), which
 * keeps them trivially testable. The route handler is responsible
 * for dispatching by toolName and for the wrapping concerns
 * (auth, ordering, savedArtifactId back-fill).
 *
 * Adding a new producer:
 *  1. Add a `rebuildXxxOutcome` here.
 *  2. Add the toolName to `REBUILDABLE_TOOLS` in `route.ts`.
 *  3. Wire the dispatch branch in `route.ts`.
 */

import "server-only";

import type {
  CardListItem,
  Outcome,
  OutcomeBlock,
} from "@/store/outcome-store";
import type {
  WebSearchOk,
  WebSearchResultEnvelope,
} from "@/lib/web-search/schema";
import {
  chartArgsToContent,
  type RenderChartArgs,
} from "@/lib/outcomes/args-to-content";

// Shared event payload shapes (mirror persisting-agent.ts)

/** Shape of payload rows stored by PersistingAgent for tool_call_chunk.
 *  See `src/lib/runner/persisting-agent.ts:258-264`. */
export interface ToolCallChunkPayload {
  toolCallId: string;
  toolName: string;
  /** `args` is the full coalesced JSON string of TOOL_CALL_ARGS deltas. */
  args: string;
}

/** Shape of payload rows stored by PersistingAgent for tool_call_result.
 *  See `src/lib/runner/persisting-agent.ts:373-378`. */
export interface ToolCallResultPayload {
  toolCallId: string;
  /** Stringified JSON return value of the server tool. */
  content: string;
}

/** Replay-time provenance for an outcome — pulled from the
 *  enclosing entity_run + event row. Threaded into rebuilders so
 *  they can stamp the Outcome without redundant DB queries. */
export interface RebuildContext {
  threadId: string;
  runId: string;
  entityId: string;
  ts: Date;
  /** Pino child logger from the route handler. Only `.warn` is used. */
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

// render_chart
//
// The args → content transformation lives in
// `lib/outcomes/args-to-content.ts`, shared with the
// save-artifact pipeline so live replay and persisted artifacts
// project the same shape into the renderer.

/**
 * Rebuild a `render_chart` outcome from its tool_call_chunk payload.
 * `outcomeId` is the LLM-supplied `chartId` (kebab-case slug) —
 * stable, and "same id overwrites" is the V1 semantic.
 *
 * Returns `null` (with a warn log) on any payload-shape issue so the
 * caller skips the row rather than crashing the whole replay.
 */
export function rebuildChartOutcome(
  chunk: ToolCallChunkPayload,
  ctx: RebuildContext,
): { id: string; outcome: Outcome } | null {
  let args: RenderChartArgs;
  try {
    args = JSON.parse(chunk.args) as RenderChartArgs;
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_parse_failed",
        tool: "render_chart",
        runId: ctx.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "skipping unparseable render_chart payload",
    );
    return null;
  }
  if (!args.chartId || !args.title) return null;
  const content = chartArgsToContent(args);
  if (content === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_missing_option",
        runId: ctx.runId,
        chartId: args.chartId,
      },
      "skipping render_chart row with no usable option payload",
    );
    return null;
  }
  return {
    id: args.chartId,
    outcome: {
      outcomeId: args.chartId,
      kind: "report",
      title: args.title,
      description: args.description,
      blocks: content.blocks,
      agentId: ctx.entityId,
      threadId: ctx.threadId,
      runId: ctx.runId,
      createdAt: ctx.ts.getTime(),
      collapsed: false,
      savedArtifactId: null,
    },
  };
}

// web_search

interface WebSearchArgsPersisted {
  query: string;
  topK?: number;
}

/**
 * Rebuild a `web_search` outcome by pairing its chunk (carrying the
 * LLM args — `query`) with its result (carrying the search results).
 * `outcomeId` is the `toolCallId`, the same id the client-side
 * `WebSearchInlinePreview` writes from, so live + replay paths
 * upsert the same row.
 *
 * Returns `null` for these skip cases:
 *  - missing matching result event (e.g. mid-flight crash, partial
 *    persistence) — the chat-inline preview's "loading" state is
 *    the better artefact in that case
 *  - args / result JSON parse failure
 *  - error envelope (`ok: false`) — failed searches show in chat,
 *    not as outcome cards (matches the live-path policy)
 */
export function rebuildWebSearchOutcome(
  chunk: ToolCallChunkPayload,
  result: ToolCallResultPayload | undefined,
  ctx: RebuildContext,
): { id: string; outcome: Outcome } | null {
  if (!result) return null;
  let args: WebSearchArgsPersisted;
  try {
    args = JSON.parse(chunk.args) as WebSearchArgsPersisted;
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_parse_failed",
        tool: "web_search",
        runId: ctx.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "skipping unparseable web_search args payload",
    );
    return null;
  }
  if (!args.query) return null;

  let envelope: WebSearchResultEnvelope;
  try {
    envelope = JSON.parse(result.content) as WebSearchResultEnvelope;
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_parse_failed",
        tool: "web_search",
        runId: ctx.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "skipping unparseable web_search result payload",
    );
    return null;
  }
  if (!envelope.ok) return null;
  const ok: WebSearchOk = envelope;
  // Citation contract (P1g): mirror the live path
  // (`WebSearchInlinePreview`) — every replayed web_search source
  // carries a 1-based `index` and `sourceKind: 'web'` so historical
  // chat threads render numbered cards identically to live ones.
  // See docs/artifact-evolution.md
  const cards: CardListItem[] = ok.results.map((r, i) => ({
    index: i + 1,
    sourceKind: "web" as const,
    ...(r.image ? { image: r.image } : {}),
    title: r.title,
    url: r.url,
    ...(tryDomain(r.url) ? { subtitle: tryDomain(r.url) } : {}),
    ...(r.snippet ? { snippet: r.snippet } : {}),
    ...(r.publishedAt ? { meta: r.publishedAt } : {}),
    ...(r.favicon ? { favicon: r.favicon } : {}),
  }));
  const block: OutcomeBlock = { kind: "card_list", cards };
  return {
    id: chunk.toolCallId,
    outcome: {
      outcomeId: chunk.toolCallId,
      kind: "report",
      title: `Search: ${args.query}`,
      description: `${ok.results.length} results · via ${ok.provider}`,
      blocks: [block],
      agentId: ctx.entityId,
      threadId: ctx.threadId,
      runId: ctx.runId,
      createdAt: ctx.ts.getTime(),
      // Replay matches the live-write policy in
      // WebSearchInlinePreview — see the comment there. Show results
      // expanded; users still have the chevron + inner "Show more"
      // for compactness on demand.
      collapsed: false,
      savedArtifactId: null,
    },
  };
}

// helpers

/** Best-effort domain extraction. Returns the empty string when
 *  the URL fails to parse so the subtitle spread in the caller
 *  silently omits the field. */
export function tryDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
