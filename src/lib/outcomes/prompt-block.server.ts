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
    "- Re-calling with the same page_id OVERWRITES the previous page.",
  ].join("\n"),
} as const;

/**
 * Return the HTML page prompt block for non-supervisor agents.
 * Mirrors `buildChartPromptBlock` in shape.
 */
export function buildHtmlPagePromptBlock(): string {
  return HTML_PAGE_PROMPT_BLOCKS.encourage;
}
