import "server-only";

// Chart prompt block for non-supervisor built-in agents.
// See docs/data-visualization.md and docs/prompts.md.

interface BuildChartPromptInput {
  /** Reserved for future block variants that vary by binding (e.g.
   *  mention `run_code_in_sandbox` aggregation only when the
   *  sandbox is bound). Currently unused — V1 always returns the
   *  same block for non-supervisor agents. */
  hasDataSource: boolean;
  /** See {@link BuildChartPromptInput.hasDataSource}. */
  hasSandbox: boolean;
}

/**
 * The canonical block string. Exported for testing / inspection.
 *
 * Scope: this block states OUR USAGE RULES for `render_chart`. The
 * tool's own description (parameter shapes, JSON examples, ECharts
 * facts) lives in `useOutcomeTools.tsx`'s schema `.describe()` — we
 * do not duplicate it here.
 */
export const CHART_PROMPT_BLOCKS = {
  /** For agents that can produce chartable data. */
  encourage: [
    "## render_chart usage",
    "",
    "- If you have no concrete data, do NOT call `render_chart`. Reply in text instead.",
    "- Put data in `option.dataset.source`, not in `series[].data`.",
    "- Do not paste chart JSON into your chat reply — the tool IS the rendering.",
  ].join("\n"),
} as const;

/**
 * Return the chart prompt block for non-supervisor agents.
 *
 * Policy: ALWAYS inject the block. `render_chart` is registered
 * globally in `useOutcomeTools()`, so every built-in agent has the
 * tool whether they have data bindings or not. Without instructions,
 * gpt-class models mis-use the tool (empty options, pasted JS in
 * chat).
 *
 * If a future agent should genuinely never have `render_chart`
 * available, the fix is at the registration layer (don't call
 * `useOutcomeTools()`), not here.
 */
export function buildChartPromptBlock(input: BuildChartPromptInput): string {
  // `hasDataSource` / `hasSandbox` are accepted but currently
  // unused — see their docstring on BuildChartPromptInput. Kept on
  // the signature so future binding-aware variants don't break the
  // caller in `runner/dispatch/builtin.ts`.
  void input;
  return CHART_PROMPT_BLOCKS.encourage;
}
