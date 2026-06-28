/**
 * Shared "tool args → renderable content" adapters.
 *
 * The artifact rendering pipeline (`ArtifactDetail.tsx → BlockList`)
 * expects `artifact.content = { blocks: OutcomeBlock[] }` — the same
 * block model the in-chat OutcomeCard renders. The save-from-chat
 * flow captures the artifact-creating tool's raw args; those args
 * need to be transformed into the block shape before they hit the
 * DB. Live replay (`/api/threads/[id]/outcomes`) needs the same
 * transformation — sharing the helpers here keeps the two surfaces
 * aligned.
 *
 * Today this covers `generate_echarts_config` only. Adding
 * `render_html` / `render_markdown` is a matter of a new
 * `xxxArgsToContent` function plus a dispatch branch in
 * `lib/artifacts/save-artifact.ts::artifactCreatorArgsToContent`.
 *
 * Pure — no DB, no I/O. Throws nothing; ill-formed input maps to
 * `null` so callers can decide whether to skip (replay) or fail
 * the save (save flow).
 */

import "server-only";

import type {
  ChartBlock,
  HtmlBlock,
  OutcomeBlock,
} from "@/store/outcome-store";

// ─── generate_echarts_config ───────────────────────────────────────────

/**
 * Subset of `generate_echarts_config` args we project into the
 * content blocks. Mirrors `generateEchartsConfigSchema` in
 * `lib/outcomes/schema.ts`.
 *
 * `option` is always a plain JSON object — the historical
 * `optionJson` string-wrapped form is gone with the frontend tool.
 */
export interface GenerateEchartsConfigArtifactArgs {
  chart_id: string;
  title: string;
  description?: string;
  option: Record<string, unknown>;
  dataset_id?: string;
}

/**
 * Build the renderable content payload for a `generate_echarts_config`
 * artifact. Returns `null` when the args don't carry a usable
 * ECharts option; the save flow surfaces that as a hard error, the
 * replay flow skips the row.
 */
export function chartArgsToContent(
  args: GenerateEchartsConfigArtifactArgs,
): { blocks: OutcomeBlock[] } | null {
  if (
    args.option === null ||
    typeof args.option !== "object" ||
    Array.isArray(args.option)
  ) {
    return null;
  }
  const block: ChartBlock = {
    kind: "chart",
    option: args.option,
    ...(args.dataset_id !== undefined && { datasetName: args.dataset_id }),
  };
  return { blocks: [block] };
}

/**
 * Defensive read of an arbitrary args object into
 * `GenerateEchartsConfigArtifactArgs` shape. Returns `null` when
 * the required fields aren't present in the expected shape — the
 * caller treats that as "this isn't a generate_echarts_config payload".
 */
export function readGenerateEchartsConfigArgs(
  args: Record<string, unknown>,
): GenerateEchartsConfigArtifactArgs | null {
  const chart_id = args.chart_id;
  const title = args.title;
  if (typeof chart_id !== "string" || chart_id.length === 0) return null;
  if (typeof title !== "string" || title.length === 0) return null;
  if (
    args.option === null ||
    typeof args.option !== "object" ||
    Array.isArray(args.option)
  ) {
    return null;
  }
  const out: GenerateEchartsConfigArtifactArgs = {
    chart_id,
    title,
    option: args.option as Record<string, unknown>,
  };
  if (typeof args.description === "string") {
    out.description = args.description;
  }
  if (typeof args.dataset_id === "string") {
    out.dataset_id = args.dataset_id;
  }
  return out;
}

// ─── generate_html_page ────────────────────────────────────────────────

/**
 * Subset of `generate_html_page` args we project into the content
 * blocks. Mirrors `generateHtmlPageSchema` in
 * `lib/outcomes/schema.ts`.
 */
export interface GenerateHtmlPageArtifactArgs {
  page_id: string;
  title: string;
  description?: string;
  html: string;
}

/**
 * Build the renderable content payload for a `generate_html_page`
 * artifact. Returns `null` when the args don't carry a usable HTML
 * string; the save flow surfaces that as a hard error, the replay
 * flow skips the row.
 */
export function htmlArgsToContent(
  args: GenerateHtmlPageArtifactArgs,
): { blocks: OutcomeBlock[] } | null {
  if (typeof args.html !== "string" || args.html.trim().length === 0) {
    return null;
  }
  const block: HtmlBlock = {
    kind: "html",
    html: args.html,
  };
  return { blocks: [block] };
}

/**
 * Defensive read of an arbitrary args object into
 * `GenerateHtmlPageArtifactArgs` shape. Returns `null` when the
 * required fields aren't present — the caller treats that as "this
 * isn't a generate_html_page payload".
 */
export function readGenerateHtmlPageArgs(
  args: Record<string, unknown>,
): GenerateHtmlPageArtifactArgs | null {
  const page_id = args.page_id;
  const title = args.title;
  if (typeof page_id !== "string" || page_id.length === 0) return null;
  if (typeof title !== "string" || title.length === 0) return null;
  if (typeof args.html !== "string" || args.html.trim().length === 0) {
    return null;
  }
  const out: GenerateHtmlPageArtifactArgs = {
    page_id,
    title,
    html: args.html,
  };
  if (typeof args.description === "string") {
    out.description = args.description;
  }
  return out;
}
