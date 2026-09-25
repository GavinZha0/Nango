import "server-only";

// Chart prompt block for non-supervisor built-in agents.
// See docs/data-visualization.md and docs/prompts.md.

interface BuildChartPromptInput {
  /** Reserved for future block variants that vary by binding (e.g.
   *  mention `run_code_in_sandbox` aggregation only when the
   *  sandbox is bound). Currently unused — always returns the
   *  same block for non-supervisor agents. */
  hasDataSource: boolean;
  /** See {@link BuildChartPromptInput.hasDataSource}. */
  hasSandbox: boolean;
}

/**
 * The canonical block string. Exported for testing / inspection.
 *
 * Scope: this block states OUR USAGE RULES for
 * `generate_echarts_config`. The tool's own description (parameter
 * shapes, JSON examples, ECharts facts) lives in the server tool
 * factory at `lib/outcomes/runtime-tools.ts` — we do not duplicate
 * it here.
 */
export const CHART_PROMPT_BLOCKS = {
  /** For agents that can produce chartable data. */
  encourage: [
    "## generate_echarts_config usage",
    "",
    "- If you have no concrete data, do NOT call `generate_echarts_config`. Reply in text instead.",
    "- Put data in `option.dataset.source` (array of row objects), NOT in `series[].data`.",
    "- The data in `dataset.source` MUST EXACTLY deep-equal the upstream tool output (e.g. `run_code_in_sandbox` or `extract_dataset_by_sql`). DO NOT rename keys or drop fields, otherwise the workflow cannot connect the nodes.",
    "- Bind columns via `series[*].encode`. For line/bar charts: `{ x: 'col', y: 'col' }`. For pie charts: `{ value: 'col', itemName: 'col' }`. YOU MUST SPECIFY THE VALUE DIMENSION.",
    "- Do not paste chart JSON into your chat reply — the tool IS the rendering.",
    "- If the data came from `extract_dataset_by_sql`, pass that dataset's id as `dataset_id` so the saved chart can refresh later.",
  ].join("\n"),
} as const;

/**
 * Return the chart prompt block for non-supervisor agents.
 *
 * Policy: ALWAYS inject the block for non-supervisor agents.
 * `generate_echarts_config` is mounted as an ambient tool on every
 * non-supervisor built-in agent in `runner/dispatch/builtin.ts`,
 * so every such agent has the tool whether they have data
 * bindings or not. Without instructions, gpt-class models mis-use
 * the tool (empty options, pasted JSON in chat).
 *
 * Supervisor agents do NOT receive this block; they also do not
 * receive the ambient tool — see the dispatch site for that
 * exclusion logic.
 */
export function buildChartPromptBlock(input: BuildChartPromptInput): string {
  // `hasDataSource` / `hasSandbox` are accepted but currently
  // unused — see their docstring on BuildChartPromptInput. Kept on
  // the signature so future binding-aware variants don't break the
  // caller in `runner/dispatch/builtin.ts`.
  void input;
  return CHART_PROMPT_BLOCKS.encourage;
}

// ─── generate_html_page ─────────────────────────────────────────────

/**
 * Usage-policy block for the `generate_html_page` server tool.
 * Same role as `CHART_PROMPT_BLOCKS` but simpler — HTML has fewer
 * structural foot-guns than ECharts options.
 */
export const HTML_PAGE_PROMPT_BLOCKS = {
  encourage: [
    "## generate_html_page usage",
    "",
    "- Generate a COMPLETE HTML page. Small CSS/JS should be inlined via <style>/<script> tags.",
    "- For large libraries (D3, Three.js, Tailwind, Chart.js, etc.), use public CDN links (e.g. cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com). This keeps the payload small.",
    "- The page renders inside a sandboxed iframe IMMEDIATELY on success — do NOT paste HTML source into your chat reply.",
    "- Only call this tool when you have concrete content to render. If the user just asks a question, reply in text.",
    "- Re-calling with the same outcome_id OVERWRITES the previous page.",
    "- outcome_id MUST contain only letters, numbers, spaces, hyphens, and underscores. Try to use clean kebab-case or snake_case (e.g., 'poetry-comparison' or 'poetry_comparison').",
  ].join("\n"),
} as const;

/**
 * Return the HTML page prompt block for non-supervisor agents.
 * Mirrors `buildChartPromptBlock` in shape.
 */
export function buildHtmlPagePromptBlock(): string {
  return HTML_PAGE_PROMPT_BLOCKS.encourage;
}

// ─── generate_bento_slides ──────────────────────────────────────────

/**
 * Usage-policy block for the `generate_bento_slides` server tool.
 * Guides LLM on generating Bento presentation documents.
 */
export const BENTO_SLIDES_PROMPT_BLOCKS = {
  encourage: [
    "## generate_bento_slides usage",
    "",
    "- Generate interactive slide deck presentations as Bento JSON documents with `format: 'bento/slides'`.",
    "- Each slide in `slides` renders onto a fixed 1280x720 canvas viewport (`size: { width: 1280, height: 720 }`).",
    "- REQUIRED: Always supply top-level `title` (matching tool argument title) and `theme`: `{ background: '#0D1117', color: '#E6EDF3', accent: '#388BFD', fontFamily: 'Inter, system-ui, sans-serif' }`.",
    "- Layout & Spacing: Keep content spacious. Recommended edge margin is 96px (x: 96, max w: 1088). Do NOT cram too much text on one slide; split across multiple slides.",
    "- Text elements: MUST use `html` field (NOT `text`), e.g. `{ id: 't1', type: 'text', x: 96, y: 120, w: 1088, h: 80, html: 'Title', fontSize: 48, fontWeight: 700, color: '#FFFFFF' }`.",
    "- Shape elements: MUST use `type: 'shape'` and specify `shape: 'rect'|'ellipse'|'line'|'arrow'`, `fill: '#...'`, `strokeWidth: 0`, e.g. `{ id: 's1', type: 'shape', shape: 'rect', x: 96, y: 220, w: 160, h: 6, fill: '#388BFD', stroke: 'transparent', strokeWidth: 0, radius: 3 }`.",
    "- Morph Transitions: If elements across consecutive slides share the exact same `id` (e.g. `id: 'hero-metric'`), set the latter slide's `transition: 'morph'`; Bento will automatically glide and morph them between slides.",
    "- Charts: Bento uses an embedded charts-lite engine (not full ECharts). Supported chart types include 'bar', 'line', 'pie'. Provide simple 1D number arrays in `series[*].data` and category labels in `xAxis.data` (e.g., `series: [{ type: 'bar', data: [120, 200, 150] }]`, `xAxis: { data: ['Q1', 'Q2', 'Q3'] }`). Do NOT use complex `dataset.source` or 2D matrices.",
    "- The slides render in the user's Outcomes preview panel IMMEDIATELY on success — do NOT paste JSON document text into your chat reply.",
    "- Multi-slide & Incremental Generation: For long presentations (> 4 slides), generate in batches: use `generate_bento_slides` for the initial deck (title, theme, and first batch), then call `edit_bento_slides` with `action: 'insert'` (omit `target_slide_ids` to append to end) for subsequent batches to avoid timeouts and output truncation.",
    "- Partial Editing & Maintenance (`edit_bento_slides`):",
    "  * Delete slides: call `edit_bento_slides` with `action: 'delete'` and `target_slide_ids: ['<slide_id>']`.",
    "  * Replace/Update a slide: call `edit_bento_slides` with `action: 'replace'`, `target_slide_ids: ['<slide_id>']`, and `slides: [updatedSlide]` (preserves slide ID).",
    "  * Insert slides: call `edit_bento_slides` with `action: 'insert'`. Omit `target_slide_ids` to append at the end; pass `target_slide_ids: ['0']` to insert at start; or pass `target_slide_ids: ['<slide_id>']` to insert immediately after that slide.",
    "- Re-calling `generate_bento_slides` with the same outcome_id OVERWRITES the previous deck entirely.",
    "- outcome_id MUST contain only letters, numbers, spaces, hyphens, and underscores. Try to use clean kebab-case or snake_case (e.g. 'quarterly-review' or 'sales_deck').",
  ].join("\n"),
} as const;

/**
 * Return the Bento slides prompt block for built-in agents.
 */
export function buildBentoSlidesPromptBlock(): string {
  return BENTO_SLIDES_PROMPT_BLOCKS.encourage;
}

