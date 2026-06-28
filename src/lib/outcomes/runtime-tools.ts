/**
 * Server-side `generate_echarts_config` agent tool.
 *
 * The server-side handler is a PURE VALIDATOR — it does NOT write
 * to any store and does NOT call any external service. The chart
 * appearing in the user's Outcomes panel is driven entirely on the
 * client side by a side-effect hook in `ChartPreviewCard` that
 * listens for this tool's `tool_call_result` event.
 *
 * See docs/workflow-spec.md (chart node + two LLM authoring
 * contexts) and docs/data-visualization.md.
 */

import "server-only";

import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";

import {
  ECHARTS_OPTION_HARD_CAP_BYTES,
  generateEchartsConfigSchema,
  type GenerateEchartsConfigArgs,
  type GenerateEchartsConfigResult,
  HTML_PAGE_HARD_CAP_BYTES,
  generateHtmlPageSchema,
  type GenerateHtmlPageArgs,
  type GenerateHtmlPageResult,
} from "./schema";

/**
 * Build the `generate_echarts_config` tool definition.
 *
 * Mounted as an ambient tool on every non-supervisor built-in agent
 * via `lib/runner/dispatch/builtin.ts` — every agent that can speak
 * to the user can therefore push a chart to the Outcomes panel.
 *
 * Validation contract:
 *   - `option` serialized JSON ≤ ECHARTS_OPTION_HARD_CAP_BYTES
 *   - `option.series` is a non-empty array
 * On failure returns `{ ok: false, error, message }` so the LLM can
 * self-correct on the next turn; on success returns the entire
 * payload (chart_id / title / description / option / dataset_id)
 * verbatim so the frontend side-effect hook can update the Outcomes
 * store without re-deriving anything from the original args.
 */
export function buildGenerateEchartsConfigTool(): ToolDefinition {
  return defineTool({
    name: "generate_echarts_config",
    description:
      "Generate an ECharts visualization config and surface it as a " +
      "preview card in the user's Outcomes panel. The chart renders " +
      "in chat IMMEDIATELY on success — DO NOT also paste chart JSON " +
      "into your text reply. Re-calling with the same chart_id " +
      "OVERWRITES the previous chart. " +
      "USE THIS when the user asks for a chart / plot / graph / " +
      "visualization AND you have concrete data values to chart. " +
      "If you have no data, reply in text instead — do not invent " +
      "or hardcode sample data. " +
      "FORMAT: put data in `option.dataset.source` (array of row " +
      "objects), and bind columns via `series[*].encode = { x, y }`. " +
      "DO NOT put values in `series[*].data`. " +
      "When the chart is rendered from data you just fetched via " +
      "`extract_dataset_by_sql`, pass that dataset's id as " +
      "`dataset_id` — this lets the save pipeline rebuild a " +
      "refreshable data binding.",
    parameters: generateEchartsConfigSchema,
    execute: async (
      args: GenerateEchartsConfigArgs,
    ): Promise<GenerateEchartsConfigResult> => {
      // size cap — measured on the serialized option
      const serialized = JSON.stringify(args.option);
      if (serialized.length > ECHARTS_OPTION_HARD_CAP_BYTES) {
        return {
          ok: false,
          error: "OPTION_TOO_LARGE",
          message:
            `option is ${serialized.length} bytes when serialized; ` +
            `cap is ${ECHARTS_OPTION_HARD_CAP_BYTES}. Aggregate via ` +
            `run_code_in_sandbox or run a SQL extraction first, then ` +
            `chart the result.`,
        };
      }

      // structure check — series must be a non-empty array
      const series = (args.option as { series?: unknown }).series;
      if (!Array.isArray(series) || series.length === 0) {
        return {
          ok: false,
          error: "OPTION_NO_SERIES",
          message:
            "option.series must be a non-empty array; each entry " +
            "must include a `type` (e.g. 'bar', 'line', 'pie').",
        };
      }

      // interceptor 1: prevent data in series
      const hasDataInSeries = series.some((s: { data?: unknown }) => s && Array.isArray(s.data) && s.data.length > 0);
      if (hasDataInSeries) {
        return {
          ok: false,
          error: "DATA_IN_SERIES",
          message: "CRITICAL: You put data inside `series[*].data`. You MUST remove it and map data exclusively via `series[*].encode` using `dataset.source`.",
        };
      }

      // interceptor 2: enforce dataset.source is an array of row objects
      const dataset = (args.option as { dataset?: { source?: unknown } }).dataset;
      const source = dataset?.source;
      if (Array.isArray(source) && source.length > 0 && Array.isArray(source[0])) {
        return {
          ok: false,
          error: "DATASET_FORMAT_INVALID",
          message: "CRITICAL: `dataset.source` is a 2D array (array of arrays). It MUST be an array of row objects (e.g. [{ name: 'apple', value: 10 }]) EXACTLY matching the upstream tool's output.",
        };
      }

      return {
        ok: true,
        chart_id: args.chart_id,
        title: args.title,
        ...(args.description !== undefined && {
          description: args.description,
        }),
        option: args.option,
        ...(args.dataset_id !== undefined && { dataset_id: args.dataset_id }),
      };
    },
  });
}

/**
 * Build the `generate_html_page` tool definition.
 *
 * Mounted as an opt-in built-in tool via the admin's "Built-in
 * Tools" checkbox. The tool validates the HTML payload size and
 * echoes it back verbatim so the frontend side-effect hook can
 * update the Outcomes store.
 *
 * Validation contract:
 *   - `html` serialized length ≤ HTML_PAGE_HARD_CAP_BYTES
 *   - `html` must be a non-empty string
 * On failure returns `{ ok: false, error, message }` so the LLM
 * can self-correct on the next turn.
 */
export function buildGenerateHtmlPageTool(): ToolDefinition {
  return defineTool({
    name: "generate_html_page",
    description:
      "Generate a complete HTML page and surface it as a preview " +
      "card in the user's Outcomes panel. The page renders in a " +
      "sandboxed iframe IMMEDIATELY on success — DO NOT paste the " +
      "HTML source into your text reply. Re-calling with the same " +
      "page_id OVERWRITES the previous page. " +
      "USE THIS when the user asks for a web page, landing page, " +
      "interactive visualization, prototype, or any rich HTML " +
      "content. " +
      "FORMAT: provide a complete HTML document string. Inline " +
      "small CSS/JS via <style>/<script> tags. For large " +
      "libraries (D3, Three.js, Tailwind, etc.) use public CDN " +
      "links (cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com). " +
      "The iframe sandbox blocks form submissions and top-level " +
      "navigation but allows scripts.",
    parameters: generateHtmlPageSchema,
    execute: async (
      args: GenerateHtmlPageArgs,
    ): Promise<GenerateHtmlPageResult> => {
      // size cap
      const byteLength = new TextEncoder().encode(args.html).length;
      if (byteLength > HTML_PAGE_HARD_CAP_BYTES) {
        return {
          ok: false,
          error: "HTML_TOO_LARGE",
          message:
            `HTML is ${byteLength} bytes; cap is ${HTML_PAGE_HARD_CAP_BYTES}. ` +
            `Move large libraries to CDN links and reduce inline content.`,
        };
      }

      // empty check (schema min(1) should catch, but belt-and-suspenders)
      if (args.html.trim().length === 0) {
        return {
          ok: false,
          error: "HTML_EMPTY",
          message: "html must contain non-whitespace content.",
        };
      }

      return {
        ok: true,
        page_id: args.page_id,
        title: args.title,
        ...(args.description !== undefined && {
          description: args.description,
        }),
        html: args.html,
      };
    },
  });
}
