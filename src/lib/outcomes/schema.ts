/**
 * Isomorphic schemas for outcome-producing tools.
 *
 * Shared between server tool factories (`runtime-tools.ts`) and
 * client-side render hooks (`useOutcomeTools.tsx`, `ChartPreviewCard`).
 *
 * No server-only imports; safe to import from client bundles.
 */

import { z } from "zod";

// ─── Caps ───────────────────────────────────────────────────────────

/**
 * Hard upper bound on the serialized ECharts option a single
 * `generate_echarts_config` call can carry. Larger payloads should
 * be aggregated server-side in a sandbox / SQL node first.
 *
 * See docs/data-visualization.md for the oversize-routing policy.
 */
export const ECHARTS_OPTION_HARD_CAP_BYTES = 64_000;

// ─── generate_echarts_config ────────────────────────────────────────

/**
 * Parameter schema for the `generate_echarts_config` server tool.
 *
 * LLM-facing — every `.describe` text ends up in the model's tool
 * catalog. The schema also drives client-side render-tool parameter
 * validation (CopilotKit `useRenderTool`).
 */
export const generateEchartsConfigSchema = z.object({
  chart_id: z
    .string()
    .regex(
      /^[a-z0-9-]+$/,
      "chart_id must be lowercase kebab-case (letters, numbers, hyphens only)",
    )
    .min(1, "chart_id cannot be empty")
    .max(64, "chart_id max 64 characters")
    .describe(
      "Stable per-thread identifier; re-calling with the same id " +
        "overwrites the previous chart. Pick a short kebab-case slug " +
        "like 'sales-pie' or 'q3-revenue'. Lowercase letters, " +
        "numbers, and hyphens only.",
    ),
  title: z
    .string()
    .min(1, "title cannot be empty")
    .describe(
      "Human-readable chart title (shown on the card header).",
    ),
  description: z
    .string()
    .optional()
    .describe("One-sentence description of what the chart shows."),
  option: z
    .record(z.string(), z.unknown())
    .describe(
      [
        "Full ECharts option as a JSON OBJECT (NOT a JSON string).",
        "Must have a non-empty `series` array; each series entry has a `type`.",
        "REQUIRED FORMAT: put data in `option.dataset.source` (array of row objects).",
        "Use series[*].encode to bind columns by name: { x: 'col_name', y: 'col_name' }.",
        "AVOID putting values in series[*].data — use dataset.source instead.",
        "",
        "Example (pie):",
        "  {",
        '    "dataset": { "source": [{ "name": "Alpha", "value": 42 }, { "name": "Beta", "value": 17 }] },',
        '    "series": [{ "type": "pie", "encode": { "itemName": "name", "value": "value" } }]',
        "  }",
        "",
        "Example (bar):",
        "  {",
        '    "dataset": { "source": [{ "q": "Q1", "v": 120 }, { "q": "Q2", "v": 200 }] },',
        '    "xAxis": { "type": "category" },',
        '    "yAxis": {},',
        '    "series": [{ "type": "bar", "encode": { "x": "q", "y": "v" } }]',
        "  }",
      ].join("\n"),
    ),
  dataset_id: z
    .string()
    .optional()
    .describe(
      "Optional: stable dataset identifier produced by an upstream " +
        "`extract_dataset_by_sql` call. When supplied, the save-time " +
        "pipeline can reconstruct a refreshable data-binding ref so " +
        "the saved chart can re-render with fresh data later.",
    ),
});

export type GenerateEchartsConfigArgs = z.infer<
  typeof generateEchartsConfigSchema
>;

/**
 * Shape returned by the server tool's `execute()` on success.
 * Mirrored verbatim into the AG-UI `tool_call_result` payload so
 * the frontend side-effect hook can read it without re-deriving
 * fields from the original args.
 */
export interface GenerateEchartsConfigSuccess {
  ok: true;
  chart_id: string;
  title: string;
  description?: string;
  option: Record<string, unknown>;
  dataset_id?: string;
}

/**
 * Shape returned by the server tool's `execute()` on validation
 * failure. `error` is a stable code; `message` is a human-readable
 * (and LLM-readable) explanation.
 */
export interface GenerateEchartsConfigFailure {
  ok: false;
  error: "OPTION_TOO_LARGE" | "OPTION_NO_SERIES" | "DATA_IN_SERIES" | "DATASET_FORMAT_INVALID";
  message: string;
}

export type GenerateEchartsConfigResult =
  | GenerateEchartsConfigSuccess
  | GenerateEchartsConfigFailure;

// ─── generate_html_page ─────────────────────────────────────────────

/**
 * Hard upper bound on the HTML string a single
 * `generate_html_page` call can carry. HTML pages are typically
 * larger than ECharts configs because they may embed inline CSS,
 * JS, and SVG content. Heavy libraries should be referenced via
 * public CDN links rather than inlined.
 */
export const HTML_PAGE_HARD_CAP_BYTES = 524_288; // 512 KB

/**
 * Parameter schema for the `generate_html_page` server tool.
 *
 * LLM-facing — every `.describe` text ends up in the model's tool
 * catalog. The schema also drives client-side render-tool parameter
 * validation (CopilotKit `useRenderTool`).
 */
export const generateHtmlPageSchema = z.object({
  page_id: z
    .string()
    .regex(
      /^[a-z0-9-]+$/,
      "page_id must be lowercase kebab-case (letters, numbers, hyphens only)",
    )
    .min(1, "page_id cannot be empty")
    .max(64, "page_id max 64 characters")
    .describe(
      "Stable per-thread identifier; re-calling with the same id " +
        "overwrites the previous page. Pick a short kebab-case slug " +
        "like 'landing-page' or 'dashboard-preview'. Lowercase " +
        "letters, numbers, and hyphens only.",
    ),
  title: z
    .string()
    .min(1, "title cannot be empty")
    .describe(
      "Human-readable page title (shown on the card header).",
    ),
  description: z
    .string()
    .optional()
    .describe("One-sentence description of what the page shows."),
  html: z
    .string()
    .min(1, "html cannot be empty")
    .describe(
      [
        "Complete, self-contained HTML page source.",
        "Small CSS/JS should be inlined via <style> and <script> tags.",
        "For large libraries (D3, Three.js, Tailwind, Chart.js, etc.), " +
          "use public CDN links (cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com).",
        "The page renders inside a sandboxed iframe — external navigation and form " +
          "submissions are blocked.",
        "",
        "Example:",
        "  <!DOCTYPE html>",
        "  <html><head><style>body{font-family:sans-serif;padding:2rem}</style></head>",
        "  <body><h1>Hello</h1><p>This is a generated page.</p></body></html>",
      ].join("\n"),
    ),
});

export type GenerateHtmlPageArgs = z.infer<typeof generateHtmlPageSchema>;

/**
 * Shape returned by the server tool's `execute()` on success.
 * Mirrored verbatim into the AG-UI `tool_call_result` payload so
 * the frontend side-effect hook can read it without re-deriving
 * fields from the original args.
 */
export interface GenerateHtmlPageSuccess {
  ok: true;
  page_id: string;
  title: string;
  description?: string;
  html: string;
}

/**
 * Shape returned by the server tool's `execute()` on validation
 * failure. `error` is a stable code; `message` is a human-readable
 * (and LLM-readable) explanation.
 */
export interface GenerateHtmlPageFailure {
  ok: false;
  error: "HTML_TOO_LARGE" | "HTML_EMPTY";
  message: string;
}

export type GenerateHtmlPageResult =
  | GenerateHtmlPageSuccess
  | GenerateHtmlPageFailure;
