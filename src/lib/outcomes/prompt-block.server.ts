import "server-only";

/**
 * Prompt-block helper for the Outcomes panel's chart frontend tool.
 *
 * The `render_chart` frontend tool is registered **globally** for
 * every built-in agent (`useOutcomeTools` in RightPanel's
 * ChatProviderHooks) — CopilotKit v2 has no per-agent registry.
 * The supervisor gets a "delegate, don't draw" block; every other
 * non-supervisor agent gets the "encourage" usage rules (see the
 * lesson-learned note on `buildChartPromptBlock` below for why we
 * inject for chat-only agents too).
 *
 * See `docs/data-visualization.md` §6.2 ("Tool registration scope —
 * global + prompt-block gating") and §6.12 Day 4.
 */

interface BuildChartPromptInput {
  /** `builtin_agent.is_supervisor` — supervisor agents get the
   *  "delegate, don't draw" block instead of the authoring rules. */
  isSupervisor: boolean;
  /** Reserved for future block variants that vary by binding (e.g.
   *  mention `run_code_in_sandbox` aggregation only when the
   *  sandbox is bound). Currently unused — V1 always returns the
   *  same block for non-supervisor agents. */
  hasDataSource: boolean;
  /** See {@link BuildChartPromptInput.hasDataSource}. */
  hasSandbox: boolean;
}

/**
 * The two canonical block strings. Exported for testing / inspection.
 *
 * Scope: these blocks state OUR USAGE RULES for `render_chart`. The
 * tool's own description (parameter shapes, JSON examples, ECharts
 * facts) lives in `useOutcomeTools.tsx`'s schema `.describe()` — we do
 * not duplicate it here.
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
  /** For supervisor agents — delegate, don't draw. */
  supervisor: [
    "## Visualization delegation",
    "",
    "If the user asks for a chart, delegate to a specialist agent with data tools.",
    "Do not call `render_chart` directly.",
  ].join("\n"),
} as const;

/**
 * Pick the right block for an agent's binding configuration.
 *
 * V1 lesson learned: the original gating (`hasDataSource || hasSandbox
 * || isSupervisor`) returned the empty string for a "plain" chat-only
 * agent. But `render_chart` itself is registered **globally** in
 * `useOutcomeTools()` — every built-in agent has the tool whether they
 * have data bindings or not. Leaving chat-only agents un-instructed
 * meant gpt-class models repeatedly mis-used the tool (submitting
 * empty options, pasting JS in chat) because the only guidance they
 * saw was the tool description.
 *
 * V1 (current) policy: ALWAYS inject a block. Supervisors get the
 * "delegate, don't draw" directive; everyone else gets the
 * authoring rules. The encourage block is ~300 tokens — small price
 * for consistent tool behaviour.
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
  if (input.isSupervisor) return CHART_PROMPT_BLOCKS.supervisor;
  return CHART_PROMPT_BLOCKS.encourage;
}
