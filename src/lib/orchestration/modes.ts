/**
 * Orchestration mode registry — picker entries + per-mode prompt
 * directive.
 *
 * Per v3, the static introduction of each routing tool now lives in
 * SUPERVISOR_CONTRACT's "## Routing tools" section. The per-mode
 * directive's job is just to NARROW that contract for the current
 * turn ("this turn only ..."), exploiting the recency-weighting
 * effect of being last in the system prompt.
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
   * Suffix appended at the very end of the supervisor's system prompt
   * (post-CONTRACT, post-catalog, post-error-policy) so the recency-
   * weighting effect lands on routing constraints for this turn.
   */
  promptDirective: string;
}

/** Common heading wrapped around every directive so the block follows
 *  the "one ## per dynamic section" convention used elsewhere. */
const MODE_SECTION_HEADER = "## Orchestration mode";

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  {
    id: "auto",
    label: "Auto",
    description:
      "Let Nango pick the routing strategy: synchronous delegation for one-shot lookups, handoff for ongoing back-and-forth.",
    promptDirective: [
      "",
      MODE_SECTION_HEADER,
      "",
      "[Mode: auto] Pick the routing tool per the selection criteria",
      "in the \"Routing tools\" section above. Default to",
      "`delegate_to_agent` when in doubt.",
    ].join("\n"),
  },
  {
    id: "tool-call",
    label: "Tool-call",
    description:
      "Force Nango to delegate every actionable request via delegate_to_agent.",
    promptDirective: [
      "",
      MODE_SECTION_HEADER,
      "",
      "[Mode: tool-call] This turn: use ONLY `delegate_to_agent` for",
      "routing. Do NOT use `switch_agent_with_context` or",
      "`delegate_async`.",
    ].join("\n"),
  },
  {
    id: "handoff",
    label: "Handoff",
    description:
      "Hand the conversation over to a specialist agent. The user will continue chatting with that agent directly.",
    promptDirective: [
      "",
      MODE_SECTION_HEADER,
      "",
      "[Mode: handoff] This turn: use ONLY `switch_agent_with_context`",
      "for routing — the user moves over to the specialist. After the",
      "call returns, do NOT keep talking; a one-line acknowledgement",
      "is fine since the user is now with the specialist.",
    ].join("\n"),
  },
  {
    id: "async",
    label: "Async",
    description:
      "Fire-and-forget: dispatch a long-running task and notify the user when it finishes.",
    promptDirective: [
      "",
      MODE_SECTION_HEADER,
      "",
      "[Mode: async] This turn: use `delegate_async` for any actionable",
      "request. The tool returns a runId immediately; tell the user",
      "something brief like \"I've started [task] — I'll let you know",
      "when it's done.\" Do NOT wait for the result or keep narrating.",
      "Plain greetings or meta-questions about how this system works",
      "are exempt — answer those briefly.",
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
