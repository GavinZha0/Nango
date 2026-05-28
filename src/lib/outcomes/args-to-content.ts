/**
 * Shared "frontend-tool args → renderable content" adapters.
 *
 * The artifact rendering pipeline (`ArtifactDetail.tsx → BlockList`)
 * expects `artifact.content = { blocks: OutcomeBlock[] }` — the same
 * block model the in-chat OutcomeCard renders. The save-from-chat
 * flow captures the frontend tool's raw args (`strippedFrontendConfig`
 * in `build-from-events.ts`); those args need to be transformed
 * into the block shape before they hit the DB. Live replay
 * (`/api/threads/[id]/outcomes`) needs the same transformation —
 * sharing the helpers here keeps the two surfaces aligned.
 *
 * V1 covers only `render_chart`. Adding `render_html` /
 * `render_markdown` is a matter of a new `xxxArgsToContent`
 * function plus a dispatch branch in
 * `lib/artifacts/save-artifact.ts::artifactCreatorArgsToContent`.
 *
 * Pure — no DB, no I/O. Throws nothing; ill-formed input maps to
 * `null` so callers can decide whether to skip (replay) or fail
 * the save (save flow).
 */

import "server-only";

import type {
  ChartBlock,
  OutcomeBlock,
} from "@/store/outcome-store";

// ─── render_chart ──────────────────────────────────────────────────────

/**
 * Subset of `render_chart` args we project into the content blocks.
 * Mirrors `renderChartSchema` in `docs/data-visualization.md` §6.3.
 *
 * Wire shape: the LLM sends `optionJson` (JSON string of the
 * full ECharts option). Older rows persisted under V1.0–V1.2
 * carry `option` (already an object); `coerceChartOption` handles
 * both for back-compat.
 */
export interface RenderChartArgs {
  chartId: string;
  title: string;
  description?: string;
  optionJson?: string;
  option?: Record<string, unknown>;
  datasetName?: string;
}

/**
 * Parse the LLM-supplied ECharts option from either `option` (V1.0
 * legacy) or `optionJson` (V1.3+ wire). Returns `null` if neither
 * yields a usable object — caller decides what to do.
 */
export function coerceChartOption(
  args: RenderChartArgs,
): Record<string, unknown> | null {
  if (
    args.option &&
    typeof args.option === "object" &&
    !Array.isArray(args.option)
  ) {
    return args.option;
  }
  if (typeof args.optionJson === "string" && args.optionJson.length > 0) {
    try {
      const decoded: unknown = JSON.parse(args.optionJson);
      if (
        decoded !== null &&
        typeof decoded === "object" &&
        !Array.isArray(decoded)
      ) {
        return decoded as Record<string, unknown>;
      }
    } catch {
      // Fall through — caller decides what to do with a null result.
    }
  }
  return null;
}

/**
 * Build the renderable content payload for a `render_chart` artifact.
 * Returns `null` when the args don't carry a usable ECharts option;
 * the save flow surfaces that as a hard error, the replay flow
 * skips the row.
 */
export function chartArgsToContent(
  args: RenderChartArgs,
): { blocks: OutcomeBlock[] } | null {
  const option = coerceChartOption(args);
  if (option === null) return null;
  const block: ChartBlock = {
    kind: "chart",
    option,
    ...(args.datasetName ? { datasetName: args.datasetName } : {}),
  };
  return { blocks: [block] };
}

/**
 * Defensive read of an arbitrary args object into `RenderChartArgs`
 * shape. Returns `null` when the required fields aren't strings —
 * the caller treats that as "this isn't a render_chart payload".
 */
export function readRenderChartArgs(
  args: Record<string, unknown>,
): RenderChartArgs | null {
  const chartId = args.chartId;
  const title = args.title;
  if (typeof chartId !== "string" || chartId.length === 0) return null;
  if (typeof title !== "string" || title.length === 0) return null;
  const out: RenderChartArgs = { chartId, title };
  if (typeof args.description === "string") out.description = args.description;
  if (typeof args.optionJson === "string") out.optionJson = args.optionJson;
  if (
    args.option !== null &&
    typeof args.option === "object" &&
    !Array.isArray(args.option)
  ) {
    out.option = args.option as Record<string, unknown>;
  }
  if (typeof args.datasetName === "string") out.datasetName = args.datasetName;
  return out;
}
