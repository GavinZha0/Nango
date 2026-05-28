/**
 * Orchestration mode registry — picker entries + per-mode prompt
 */

/** Mode identifiers. Narrow union (not `string`) so typos surface. */
export type OrchestrationModeId = "auto" | "tool-call" | "handoff" | "async";

export interface OrchestrationMode {
  id: OrchestrationModeId;
  /** Short label rendered in the picker chip. */
  label: string;
  /** One-line tooltip / dropdown description. */
  description: string;
  /**
   * Suffix appended to the supervisor's system prompt when this mode
   * is active. Empty string means "no behavioural change".
   *
   * QUIRK: directive is advisory — we do NOT override
   * `toolChoice='required'`. Forcing tool calls for trivial messages
   * ("hello") would be hostile UX.
   */
  promptDirective: string;
}

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  {
    id: "auto",
    label: "Auto",
    description:
      "Let Nango pick the routing strategy: synchronous delegation for one-shot lookups, handoff for ongoing back-and-forth.",
    promptDirective: [
      "",
      "[Mode: auto]",
      "Pick the routing tool yourself based on the request's nature:",
      "  - `delegate_to_agent` — when the user wants a one-shot answer or",
      "    summary and expects to keep talking to you. You await the",
      "    specialist's reply and report it back in your own words.",
      "  - `switch_agent_with_context` — when the user is starting an",
      "    ongoing task that benefits from talking directly to the",
      "    specialist (multi-turn debugging, exploratory dialogue,",
      "    operations the specialist's UI handles natively). Pass a",
      "    self-contained briefing as `contextSummary`. After this",
      "    returns, the user is no longer with you.",
      "Default to `delegate_to_agent` when in doubt.",
    ].join("\n"),
  },
  {
    id: "tool-call",
    label: "Tool-call",
    description:
      "Force Nango to delegate every actionable request via delegate_to_agent.",
    promptDirective: [
      "",
      "[Mode: tool-call]",
      "Use ONLY `delegate_to_agent` for routing — you await the",
      "specialist's result and summarise it back to the user. Do NOT",
      "use `switch_agent_with_context` in this mode.",
    ].join("\n"),
  },
  {
    id: "handoff",
    label: "Handoff",
    description:
      "Hand the conversation over to a specialist agent. The user will continue chatting with that agent directly.",
    promptDirective: [
      "",
      "[Mode: handoff]",
      "Use ONLY `switch_agent_with_context` for routing — the user",
      "moves over to the specialist. Pass a self-contained briefing as",
      "`contextSummary` so the specialist can continue without needing",
      "the original transcript. Do NOT use `delegate_to_agent` in this",
      "mode. After the call returns, do NOT keep talking — a one-line",
      "acknowledgement is fine since the user is now with the specialist.",
    ].join("\n"),
  },
  {
    id: "async",
    label: "Async",
    description:
      "Fire-and-forget: dispatch a long-running task and notify the user when it finishes.",
    promptDirective: [
      "",
      "[Mode: async]",
      "The user has enabled async mode. Use `delegate_async` (instead",
      "of `delegate_to_agent`) for any actionable request. The tool",
      "returns a runId immediately; tell the user something brief",
      "like \"I've started [task] — I'll let you know when it's done.\"",
      "Do NOT wait for the result and do NOT keep narrating. The user",
      "will be notified through the notifications panel when the",
      "specialist finishes. Plain greetings or meta-questions about",
      "how this system works are exempt — answer those briefly.",
    ].join("\n"),
  },
];

export const DEFAULT_ORCHESTRATION_MODE: OrchestrationModeId = "auto";

// Re-exported for back-compat. The canonical definition lives in
// `lib/http/chat-headers.ts` alongside `CREDENTIAL_ID_HEADER` — see
// docs/orchestrator.md "Custom HTTP Headers" for the rationale.
export { ORCHESTRATION_MODE_HEADER } from "@/lib/http/chat-headers";

/**
 * CONTRACT: returns the default mode when `value` is missing or
 * unrecognised; never throws. Picker only emits valid ids — the
 * fallback is defensive.
 */
export function resolveOrchestrationMode(
  value: string | null | undefined,
): OrchestrationMode {
  const id = value?.toLowerCase();
  const mode = ORCHESTRATION_MODES.find((m) => m.id === id);
  if (mode) return mode;
  return ORCHESTRATION_MODES.find((m) => m.id === DEFAULT_ORCHESTRATION_MODE)!;
}
