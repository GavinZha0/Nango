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
  SlideBlock,
} from "@/store/outcome-store";
import type {
  WebSearchOk,
  WebSearchResultEnvelope,
} from "@/lib/web-search/schema";
import {
  chartArgsToContent,
  htmlArgsToContent,
  slideArgsToContent,
  readGenerateEchartsConfigArgs,
  readGenerateHtmlPageArgs,
  readGenerateBentoSlidesArgs,
  readEditBentoSlidesArgs,
  type GenerateEchartsConfigArtifactArgs,
  type GenerateHtmlPageArtifactArgs,
  type GenerateBentoSlidesArtifactArgs,
  type EditBentoSlidesArtifactArgs,
} from "@/lib/outcomes/args-to-content";
import { normalizeOutcomeId } from "./schema";
import { applySlideEdit } from "./merge-slides";

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

// generate_echarts_config
//
// The args → content transformation lives in
// `lib/outcomes/args-to-content.ts`, shared with the
// save-artifact pipeline so live replay and persisted artifacts
// project the same shape into the renderer.

/**
 * Rebuild a `generate_echarts_config` outcome from its
 * tool_call_chunk payload. `outcomeId` is the LLM-supplied
 * `chart_id` (kebab-case slug) — stable, and "same id overwrites"
 * is the policy.
 *
 * Returns `null` (with a warn log) on any payload-shape issue so the
 * caller skips the row rather than crashing the whole replay.
 */
export function rebuildChartOutcome(
  chunk: ToolCallChunkPayload,
  ctx: RebuildContext,
): { id: string; outcome: Outcome } | null {
  let rawArgs: Record<string, unknown>;
  try {
    rawArgs = JSON.parse(chunk.args) as Record<string, unknown>;
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_parse_failed",
        tool: "generate_echarts_config",
        runId: ctx.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "skipping unparseable generate_echarts_config payload",
    );
    return null;
  }
  const args: GenerateEchartsConfigArtifactArgs | null =
    readGenerateEchartsConfigArgs(rawArgs);
  if (args === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_invalid_args",
        tool: "generate_echarts_config",
        runId: ctx.runId,
      },
      "skipping generate_echarts_config row with invalid args shape",
    );
    return null;
  }
  const content = chartArgsToContent(args);
  if (content === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_missing_option",
        runId: ctx.runId,
        outcomeId: args.outcome_id,
      },
      "skipping generate_echarts_config row with no usable option payload",
    );
    return null;
  }
  const normalizedId = normalizeOutcomeId(args.outcome_id);
  return {
    id: normalizedId,
    outcome: {
      outcomeId: normalizedId,
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

// generate_html_page
//
// Same rebuild-from-chunk-only pattern as generate_echarts_config.

/**
 * Rebuild a `generate_html_page` outcome from its
 * tool_call_chunk payload. `outcomeId` is the LLM-supplied
 * `page_id` (kebab-case slug) — stable, and "same id overwrites"
 * is the policy.
 *
 * Returns `null` (with a warn log) on any payload-shape issue so the
 * caller skips the row rather than crashing the whole replay.
 */
export function rebuildHtmlPageOutcome(
  chunk: ToolCallChunkPayload,
  ctx: RebuildContext,
): { id: string; outcome: Outcome } | null {
  let rawArgs: Record<string, unknown>;
  try {
    rawArgs = JSON.parse(chunk.args) as Record<string, unknown>;
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_parse_failed",
        tool: "generate_html_page",
        runId: ctx.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "skipping unparseable generate_html_page payload",
    );
    return null;
  }
  const args: GenerateHtmlPageArtifactArgs | null =
    readGenerateHtmlPageArgs(rawArgs);
  if (args === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_invalid_args",
        tool: "generate_html_page",
        runId: ctx.runId,
      },
      "skipping generate_html_page row with invalid args shape",
    );
    return null;
  }
  const content = htmlArgsToContent(args);
  if (content === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_missing_html",
        runId: ctx.runId,
        outcomeId: args.outcome_id,
      },
      "skipping generate_html_page row with no usable html payload",
    );
    return null;
  }
  const finalPageId = normalizeOutcomeId(args.outcome_id);
  return {
    id: finalPageId,
    outcome: {
      outcomeId: finalPageId,
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

// generate_bento_slides
//
// Unlike generate_echarts_config / generate_html_page which rebuild from the
// chunk alone, Bento slides require a paired result to confirm the server
// tool accepted the payload (ok: true). This prevents replaying failed
// generate calls (e.g. DOC_TOO_LARGE) as if they succeeded.

/**
 * Rebuild a `generate_bento_slides` outcome from its tool_call_chunk
 * payload and the paired tool_call_result.
 *
 * Passing `result` is strongly preferred; when it is absent (e.g. the
 * result event has not yet been written for an in-flight run) the
 * rebuilder falls back to chunk-only mode as before.
 */
export function rebuildBentoSlidesOutcome(
  chunk: ToolCallChunkPayload,
  ctx: RebuildContext,
  priorOutcome?: Outcome,
  result?: ToolCallResultPayload,
): { id: string; outcome: Outcome } | null {
  // CONTRACT: When a paired result is available, only rebuild if the
  // server tool returned ok: true.  Skips DOC_TOO_LARGE / DOC_NO_SLIDES /
  // SLIDE_MISSING_ID failures so replay doesn't surface ghost outcomes.
  if (result !== undefined) {
    try {
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      if (parsed.ok !== true) {
        ctx.log.warn(
          {
            event: "outcomes_replay_tool_failed",
            tool: "generate_bento_slides",
            runId: ctx.runId,
            error: parsed.error,
          },
          "skipping generate_bento_slides with ok:false result",
        );
        return null;
      }
    } catch {
      // Unparseable result content — fall through to chunk-only rebuild
      // rather than silently discarding potentially valid outcomes.
    }
  }

  let rawArgs: Record<string, unknown>;
  try {
    rawArgs = JSON.parse(chunk.args) as Record<string, unknown>;
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_parse_failed",
        tool: "generate_bento_slides",
        runId: ctx.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "skipping unparseable generate_bento_slides payload",
    );
    return null;
  }
  const args: GenerateBentoSlidesArtifactArgs | null =
    readGenerateBentoSlidesArgs(rawArgs);
  if (args === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_invalid_args",
        tool: "generate_bento_slides",
        runId: ctx.runId,
      },
      "skipping generate_bento_slides row with invalid args shape",
    );
    return null;
  }

  const priorSlideBlock = priorOutcome?.blocks.find(
    (b): b is SlideBlock => b.kind === "slide",
  );

  // CONTRACT: Global toolCallId idempotency guard across runs
  // If this toolCallId was already processed into priorOutcome,
  // short-circuit return to prevent replayed initial chunks from resetting the outcome.
  if (priorOutcome && priorSlideBlock?.appliedToolCallIds?.includes(chunk.toolCallId)) {
    return { id: normalizeOutcomeId(args.outcome_id), outcome: priorOutcome };
  }

  const content = slideArgsToContent({
    ...args,
    doc: args.doc,
  });
  if (content === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_missing_doc",
        runId: ctx.runId,
        outcomeId: args.outcome_id,
      },
      "skipping generate_bento_slides row with no usable doc payload",
    );
    return null;
  }
  const slideBlock = content.blocks[0];
  if (slideBlock && slideBlock.kind === "slide") {
    slideBlock.appliedToolCallIds = [chunk.toolCallId];
  }

  const finalOutcomeId = normalizeOutcomeId(args.outcome_id);
  return {
    id: finalOutcomeId,
    outcome: {
      outcomeId: finalOutcomeId,
      kind: "report",
      title: priorOutcome?.title ?? args.title,
      description: priorOutcome?.description ?? args.description,
      blocks: content.blocks,
      agentId: ctx.entityId,
      threadId: ctx.threadId,
      runId: ctx.runId,
      createdAt: priorOutcome?.createdAt ?? ctx.ts.getTime(),
      collapsed: priorOutcome ? priorOutcome.collapsed : false,
      savedArtifactId: priorOutcome?.savedArtifactId ?? null,
    },
  };
}

/**
 * Rebuild a Bento slides outcome modified by an `edit_bento_slides` tool call.
 *
 * Passing `result` is strongly preferred; when available the rebuilder checks
 * `ok: true` before applying the edit, matching the behaviour of save-artifact.ts.
 */
export function rebuildBentoSlideEditOutcome(
  chunk: ToolCallChunkPayload,
  ctx: RebuildContext,
  priorOutcome?: Outcome,
  result?: ToolCallResultPayload,
): { id: string; outcome: Outcome } | null {
  // CONTRACT: When a paired result is available, only apply the edit if the
  // server tool returned ok: true.  Skips REPLACE_COUNT_MISMATCH /
  // DUPLICATE_SLIDE_ID / other validation failures at replay time.
  if (result !== undefined) {
    try {
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      if (parsed.ok !== true) {
        ctx.log.warn(
          {
            event: "outcomes_replay_tool_failed",
            tool: "edit_bento_slides",
            runId: ctx.runId,
            error: parsed.error,
          },
          "skipping edit_bento_slides with ok:false result",
        );
        return priorOutcome ? { id: normalizeOutcomeId(String((JSON.parse(chunk.args) as Record<string, unknown>).outcome_id ?? "")), outcome: priorOutcome } : null;
      }
    } catch {
      // Unparseable result content — fall through to chunk-args mode.
    }
  }

  let rawArgs: Record<string, unknown>;
  try {
    rawArgs = JSON.parse(chunk.args) as Record<string, unknown>;
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_parse_failed",
        tool: "edit_bento_slides",
        runId: ctx.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      "skipping unparseable edit_bento_slides payload",
    );
    return null;
  }

  const args: EditBentoSlidesArtifactArgs | null =
    readEditBentoSlidesArgs(rawArgs);
  if (args === null) {
    ctx.log.warn(
      {
        event: "outcomes_replay_invalid_args",
        tool: "edit_bento_slides",
        runId: ctx.runId,
      },
      "skipping edit_bento_slides row with invalid args shape",
    );
    return null;
  }

  const normId = normalizeOutcomeId(args.outcome_id);
  if (!priorOutcome) {
    return null;
  }

  const priorSlideBlock = priorOutcome.blocks.find(
    (b): b is SlideBlock => b.kind === "slide",
  );
  if (!priorSlideBlock || !priorSlideBlock.doc) {
    return null;
  }

  // CONTRACT: ToolCallId idempotency guard
  if (priorSlideBlock.appliedToolCallIds?.includes(chunk.toolCallId)) {
    return { id: normId, outcome: priorOutcome };
  }

  // Prefer server-validated result fields over raw chunk.args when a result
  // is available (mirrors the save-artifact.ts fix: result.slides has IDs
  // already locked by the server tool's normalizedSlides step).
  let editAction = args.action;
  let editTargetIds = args.target_slide_ids;
  let editSlides = args.slides;
  if (result !== undefined) {
    try {
      const parsedResult = JSON.parse(result.content) as Record<string, unknown>;
      if (typeof parsedResult.action === "string") {
        editAction = parsedResult.action as typeof args.action;
      }
      if (Array.isArray(parsedResult.target_slide_ids)) {
        editTargetIds = (parsedResult.target_slide_ids as unknown[]).map(String);
      }
      if (Array.isArray(parsedResult.slides)) {
        editSlides = parsedResult.slides as Array<Record<string, unknown>>;
      }
    } catch {
      // Fall through to chunk-derived values already set above.
    }
  }

  const editRes = applySlideEdit(priorSlideBlock.doc, {
    action: editAction,
    target_slide_ids: editTargetIds,
    slides: editSlides,
  });

  if (!editRes.changed) {
    return { id: normId, outcome: priorOutcome };
  }

  const nextAppliedIds = [
    ...(priorSlideBlock.appliedToolCallIds ?? []),
    chunk.toolCallId,
  ];

  const updatedBlocks = priorOutcome.blocks.map((b) =>
    b.kind === "slide"
      ? {
          ...b,
          doc: editRes.doc,
          appliedToolCallIds: nextAppliedIds,
        }
      : b,
  );

  return {
    id: normId,
    outcome: {
      ...priorOutcome,
      blocks: updatedBlocks,
    },
  };
}

// image outcomes from MCP / screenshot tools

/**
 * Rebuild an image outcome from a tool_call_result carrying MCP image content.
 */
export function rebuildImageOutcome(
  chunk: ToolCallChunkPayload | undefined,
  result: ToolCallResultPayload,
  ctx: RebuildContext,
): { id: string; outcome: Outcome } | null {
  if (!result || !result.content) return null;
  try {
    const parsed =
      typeof result.content === "string"
        ? (JSON.parse(result.content) as Record<string, unknown>)
        : (result.content as Record<string, unknown>);

    if (!parsed || typeof parsed !== "object") return null;

    const contentList: Array<Record<string, unknown>> = Array.isArray(parsed.content)
      ? (parsed.content as Array<Record<string, unknown>>)
      : Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : [];

    const imageBlocks: OutcomeBlock[] = [];
    for (const item of contentList) {
      if (item && item.type === "image") {
        const url = typeof item.url === "string" ? item.url : null;
        const data = typeof item.data === "string" ? item.data : null;
        const mimeType = typeof item.mimeType === "string" ? item.mimeType : "image/png";

        if (url) {
          imageBlocks.push({ kind: "image", src: url, mimeType, alt: "Tool image output" });
        } else if (data && !data.startsWith("[")) {
          const src = data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
          imageBlocks.push({ kind: "image", src, mimeType, alt: "Tool image output" });
        }
      }
    }

    if (imageBlocks.length === 0) return null;

    const toolName = chunk?.toolName ?? "tool";
    return {
      id: result.toolCallId,
      outcome: {
        outcomeId: result.toolCallId,
        kind: "report",
        title: `Screenshot: ${toolName}`,
        description: `Captured from ${toolName}`,
        blocks: imageBlocks,
        agentId: ctx.entityId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        createdAt: ctx.ts.getTime(),
        collapsed: false,
        savedArtifactId: null,
      },
    };
  } catch (err) {
    ctx.log.warn(
      {
        event: "outcomes_replay_image_failed",
        toolCallId: result.toolCallId,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to rebuild image outcome from result",
    );
    return null;
  }
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
