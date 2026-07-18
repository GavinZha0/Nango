"use client";

/**
 * DelegateToAgentCard — semantic renderer for `delegate_to_agent` tool calls.
 *
 * Visual identity stays distinct from the wildcard renderer (purple
 * accent + Sparkles icon + "Delegated to {agent}" headline) because
 * delegation is an orchestration action, not a regular tool call —
 * users should see it stand out from the run of plain server-tool
 * cards rendered by `WildcardToolRenderer`.
 *
 * Result interpretation (success/failure detection, error message
 * extraction, elapsed-time tracking, status badge) is delegated to the
 * shared helpers in `src/lib/copilot/detect-tool-result-status.ts` and
 * `src/components/copilotkit/`. This keeps the failure-detection
 * convention identical to what the admin run-detail timeline and the
 * wildcard renderer use.
 */

import { z } from "zod";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useState, type ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/store/workspace";
import {
  detectToolResultStatus,
  extractErrorMessage,
} from "@/lib/copilot/detect-tool-result-status";
import { useElapsedSeconds } from "@/components/copilotkit/use-elapsed-seconds";
import {
  ToolStatusBadge,
  deriveBadgeStatus,
} from "@/components/copilotkit/ToolStatusBadge";

/** Standard-Schema (zod) shape for `delegate_to_agent` args. Mirrors server-side; kept parallel to avoid pulling `server-only` into client bundle. */
export const delegateToAgentArgsSchema = z.object({
  /** Display name from "Available specialists" list; server resolves to internal id. */
  agent: z.string(),
  task: z.string(),
});

export type DelegateToAgentArgs = z.infer<typeof delegateToAgentArgsSchema>;

/** Tool result shape — only `summary` is consumed here. Status and
 *  error-message extraction now live in the shared detector module. */
interface DelegateResult {
  summary?: string;
}

/** Discriminated union matching CopilotKit v2's `RenderToolProps`. Re-declared locally to avoid unstable deep imports. */
export type DelegateRenderProps =
  | {
      name: string;
      toolCallId: string;
      parameters: Partial<DelegateToAgentArgs>;
      status: "inProgress";
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      parameters: DelegateToAgentArgs;
      status: "executing";
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      parameters: DelegateToAgentArgs;
      status: "complete";
      result: string;
    };

/** Extract just the `summary` field from a result JSON. Returns "" on
 *  malformed payloads or missing field — caller falls back to "no output". */
function parseSummary(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as DelegateResult;
      return obj.summary ?? "";
    }
  } catch {
    /* fall through */
  }
  return "";
}

export function DelegateToAgentCard(props: DelegateRenderProps): ReactElement {
  const { parameters: args, status, toolCallId } = props;
  const result = status === "complete" ? props.result : undefined;
  // Display name from args; fallback for brief pre-emission window.
  const targetName = (args?.agent ?? "agent").trim() || "agent";

  const detected = detectToolResultStatus(result);
  
  const pendingApprovals = useWorkspaceStore((s) => s.pendingApprovals);
  // Helper to compare parameters
  const matchesArgs = (a: unknown, b: unknown): boolean => {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  };
  const pendingApproval = pendingApprovals.find(
    (a) => a.toolName === "delegate_to_agent" && matchesArgs(a.args, args)
  );

  const badgeStatus = pendingApproval ? "waiting" : deriveBadgeStatus(status, detected);
  const elapsed = useElapsedSeconds(toolCallId, badgeStatus === "running");

  // Both `error` and `warning` carry an `isError: true` envelope with
  // a human-readable `message`; we surface it in the expanded body in
  // place of `summary`. Colour differs by severity (red vs muted) so
  // the visual stays consistent with the badge.
  const annotated = badgeStatus === "error" || badgeStatus === "warning";
  const headerMessage = annotated
    ? extractErrorMessage(result) ??
      (badgeStatus === "error" ? "Delegation failed." : "No result recorded.")
    : null;
  const summary = parseSummary(result);

  // Default collapsed for both success and failure. Header already
  // carries enough context (badge colour + agent name) and the LLM
  // narration explains the outcome in plain text; click to expand
  // for task/summary/error details.
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-purple-500/20 bg-purple-500/[0.04]">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-purple-500/[0.06]"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-300" />
        <span className="text-xs font-medium text-purple-700 dark:text-purple-200">
          {status === "complete"
            ? `Delegated to ${targetName}`
            : `Delegating to ${targetName}`}
        </span>
        {/* See WildcardToolRenderer for the rationale — hiding on
            "0s" filters out history-replay timers and the sub-second
            mount flash on fresh live calls. */}
        {elapsed !== "0s" && (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            · {elapsed}
          </span>
        )}
        <span className="flex-1" />
        <ToolStatusBadge status={badgeStatus} />
        {expanded ? (
          <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground")} />
        ) : (
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground")} />
        )}
      </button>

      {/* Body (expanded) */}
      {expanded && (
        <>
          {args?.task && (
            <div className="border-t border-purple-500/15 px-3 py-1.5 text-[11px] italic text-muted-foreground">
              “{args.task}”
            </div>
          )}
          {status === "complete" && (
            <div className="border-t border-purple-500/15 px-3 py-2">
              {annotated && headerMessage ? (
                <p
                  className={cn(
                    "whitespace-pre-wrap text-xs",
                    badgeStatus === "error"
                      ? "text-red-600 dark:text-red-300"
                      : "text-muted-foreground italic",
                  )}
                >
                  {headerMessage}
                </p>
              ) : summary.length > 0 ? (
                <p className="whitespace-pre-wrap text-xs text-foreground">
                  {summary}
                </p>
              ) : (
                <p className="text-xs italic text-muted-foreground">
                  (no textual output)
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
