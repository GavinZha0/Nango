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

export function normalizeOutcomeId(val: string): string {
  return val
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]+/g, "")
    .replace(/-+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
}

export const normalizeChartId = normalizeOutcomeId;
export const normalizePageId = normalizeOutcomeId;
export const normalizeSlideId = normalizeOutcomeId;

// ─── generate_echarts_config ────────────────────────────────────────

/**
 * Parameter schema for the `generate_echarts_config` server tool.
 *
 * LLM-facing — every `.describe` text ends up in the model's tool
 * catalog. The schema also drives client-side render-tool parameter
 * validation (CopilotKit `useRenderTool`).
 */
export const generateEchartsConfigSchema = z.object({
  outcome_id: z
    .string()
    .regex(
      /^[a-zA-Z0-9-_\s]+$/,
      "outcome_id must contain only letters, numbers, spaces, hyphens, and underscores",
    )
    .min(1, "outcome_id cannot be empty")
    .max(64, "outcome_id max 64 characters")
    .describe(
      "Stable per-thread identifier; re-calling with the same id " +
        "overwrites the previous chart. Pick a short kebab-case or snake_case slug " +
        "like 'sales-pie', 'q3-revenue', or 'sales_pie'. Letters, " +
        "numbers, spaces, hyphens, and underscores only.",
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
  outcome_id: string;
  title: string;
  description?: string;
  option: Record<string, unknown>;
  dataset_id?: string;
  message?: string;
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
  outcome_id: z
    .string()
    .regex(
      /^[a-zA-Z0-9-_\s]+$/,
      "outcome_id must contain only letters, numbers, spaces, hyphens, and underscores",
    )
    .min(1, "outcome_id cannot be empty")
    .max(64, "outcome_id max 64 characters")
    .describe(
      "Stable per-thread identifier; re-calling with the same id " +
        "overwrites the previous page. Pick a short kebab-case or snake_case slug " +
        "like 'landing-page', 'dashboard-preview', or 'poetry_comparison'. " +
        "Letters, numbers, spaces, hyphens, and underscores only.",
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
  outcome_id: string;
  title: string;
  description?: string;
  html: string;
  message?: string;
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

// ─── generate_bento_slides ──────────────────────────────────────────

/**
 * Hard upper bound on the serialized Bento doc JSON a single
 * `generate_bento_slides` call can carry (512 KB).
 */
export const BENTO_DOC_HARD_CAP_BYTES = 524_288;

/**
 * Parameter schema for the `generate_bento_slides` server tool.
 *
 * Drives both LLM parameter catalog and client-side tool parameter
 * validation (CopilotKit `useRenderTool`).
 */
export const generateBentoSlidesSchema = z.object({
  outcome_id: z
    .string()
    .regex(
      /^[a-zA-Z0-9-_\s]+$/,
      "outcome_id must contain only letters, numbers, spaces, hyphens, and underscores",
    )
    .min(1, "outcome_id cannot be empty")
    .max(64, "outcome_id max 64 characters")
    .describe(
      "Stable per-thread identifier; re-calling with the same id " +
        "overwrites the previous slides deck. Pick a short kebab-case or snake_case slug " +
        "like 'q3-growth', 'product-launch', or 'tech-architecture'. " +
        "Letters, numbers, spaces, hyphens, and underscores only.",
    ),
  title: z
    .string()
    .min(1, "title cannot be empty")
    .describe("Human-readable presentation title (shown on preview cards)."),
  description: z
    .string()
    .optional()
    .describe("One-sentence summary of what this presentation covers."),
  append: z
    .boolean()
    .optional()
    .describe(
      "Optional: if true, appends the provided slides to the existing presentation with outcome_id. " +
        "If false (default), replaces or creates a new presentation. " +
        "Use append: true when generating multi-slide presentations incrementally to avoid timeouts.",
    ),
  doc: z
    .record(z.string(), z.unknown())
    .describe(
      [
        "Complete Bento Slides document as a JSON OBJECT (NOT a string).",
        "Must specify 'format': 'bento/slides', 'version': 1, 'title': '...', 'size': { 'width': 1280, 'height': 720 }, and a non-empty 'slides' array.",
        "REQUIRED: 'title' (same as presentation title), 'theme': { 'background': '#0D1117', 'color': '#E6EDF3', 'accent': '#388BFD', 'fontFamily': 'Inter, system-ui, sans-serif' }.",
        "Each slide entry requires: id, elements array, and optional transition ('none' | 'morph' | 'fade').",
        "Elements format:",
        "  - Text: { id, type: 'text', x, y, w, h, html: '...', fontSize, fontWeight, color, align: 'left'|'center'|'right' } (NOTE: use 'html', not 'text').",
        "  - Shape: { id, type: 'shape', shape: 'rect'|'ellipse'|'line'|'arrow', x, y, w, h, fill: '#...', stroke: 'transparent', strokeWidth: 0, radius?: 8 }.",
        "  - Chart: { id, type: 'chart', x, y, w, h, preset: 'bar'|'line'|'pie'|'scatter', option: { xAxis: { data: [...] }, series: [{ type: 'bar', data: [10, 20] }] } }.",
        "Bento Best Practices:",
        "  - Consecutive slides showing evolution: use the SAME element id + transition: 'morph'.",
        "  - Spacing: respect 96px side margins (x: 96, max w: 1088) for a clean presentation look.",
      ].join("\n"),
    ),
});

export type GenerateBentoSlidesArgs = z.infer<
  typeof generateBentoSlidesSchema
>;

export interface GenerateBentoSlidesSuccess {
  ok: true;
  outcome_id: string;
  title: string;
  description?: string;
  doc: Record<string, unknown>;
  append?: boolean;
  message?: string;
}

export interface GenerateBentoSlidesFailure {
  ok: false;
  error: "DOC_TOO_LARGE" | "DOC_INVALID_FORMAT" | "DOC_NO_SLIDES";
  message: string;
}

export type GenerateBentoSlidesResult =
  | GenerateBentoSlidesSuccess
  | GenerateBentoSlidesFailure;

