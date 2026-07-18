"use client";

/**
 * WildcardToolRenderer — the fallback chat-side renderer for every
 * tool call that doesn't have a name-specific `useRenderTool`
 * registration (MCP tools, sandbox `run_code_in_sandbox`,
 * `extract_dataset_by_sql`, `run_ssh_command`, `list_ssh_hosts`,
 * `get_skill`, `get_skill_file`, `run_skill_script`, all the
 * supervisor schedule tools, and anything new added later).
 *
 * Replaces CopilotKit's built-in `DefaultToolCallRenderer` (registered
 * via `useDefaultRenderTool()` with `render: WildcardToolRenderer`).
 * The visual style intentionally mirrors the vendor default — low-key
 * grey-themed card — so the only user-visible behavioural difference
 * is the badge colour reacting to result content:
 *
 *   - tool execute throws (caught by wrapToolExecute, returns
 *     { isError: true, message, toolName })             → red Error
 *   - tool returns business failure (e.g. { ok: false })  → red Error
 *   - tool returns process-result envelope with
 *     non-zero exitCode (run_code_in_sandbox traceback)  → red Error
 *   - tool returns recognised success                     → green Done
 *   - tool returns unrecognised shape                     → green Done
 *     (we don't infer failure from absence of a flag)
 *   - tool still running                                  → amber Running
 *
 * The full envelope-detection rules live in
 * `lib/copilot/detect-tool-result-status.ts`, mirrored by the save
 * pipeline's `coalesce-tool-calls.ts::isFailedEnvelope` so the chat
 * card, admin event timeline, and workflow save filter all agree.
 *
 * On failure the error message is surfaced in the collapsed-state
 * header so the user doesn't have to expand to see what went wrong;
 * the expanded view shows the full args + result JSON for debugging.
 * For sandbox failures the surfaced message is the `stderr` text
 * (Python traceback, ModuleNotFoundError, OOM, …).
 */

import { useState, type ReactElement } from "react";
import { ChevronDown, ChevronRight, Wrench, Check, X } from "lucide-react";
import { useWorkspaceStore } from "@/store/workspace";
import { cn } from "@/lib/utils";

import {
  detectToolResultStatus,
  extractErrorMessage,
} from "@/lib/copilot/detect-tool-result-status";
import { useElapsedSeconds } from "@/components/copilotkit/use-elapsed-seconds";
import {
  ToolStatusBadge,
  deriveBadgeStatus,
} from "@/components/copilotkit/ToolStatusBadge";

/** Props CopilotKit v2 passes to wildcard / per-tool renderers.
 *  Locally re-declared (matches `RenderToolProps` minus the schema
 *  generic) to avoid deep imports into CopilotKit internals. */
export type WildcardRenderProps = {
  name: string;
  toolCallId: string;
  parameters: unknown;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
};

/** Pretty-print arbitrary parameters object. Empty objects render as
 *  `{}` (the CopilotKit default behaviour); we don't substitute a
 *  custom "(no arguments)" string to keep the visual cue minimal. */
function formatParameters(parameters: unknown): string {
  try {
    return JSON.stringify(parameters ?? {}, null, 2);
  } catch {
    return String(parameters);
  }
}

export function WildcardToolRenderer({
  name,
  toolCallId,
  parameters,
  status,
  result,
}: WildcardRenderProps): ReactElement {
  const pendingApprovals = useWorkspaceStore((s) => s.pendingApprovals);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [localConfirmed, setLocalConfirmed] = useState<boolean | null>(null);

  // Helper to compare parameters
  const matchesArgs = (a: unknown, b: unknown): boolean => {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  };

  const pendingApproval = pendingApprovals.find(
    (a) => a.toolCallId ? a.toolCallId === toolCallId : (a.toolName === name && matchesArgs(a.args, parameters))
  );

  const handleApprove = async () => {
    if (!pendingApproval) return;
    setApproving(true);
    try {
      const res = await fetch(`/api/runs/${pendingApproval.runId}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: pendingApproval.approvalId,
          approved: true,
        }),
      });
      if (res.ok) {
        setLocalConfirmed(true);
      } else {
        throw new Error("Approval failed");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to approve tool execution.");
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    if (!pendingApproval) return;
    setRejecting(true);
    try {
      const res = await fetch(`/api/runs/${pendingApproval.runId}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: pendingApproval.approvalId,
          approved: false,
        }),
      });
      if (res.ok) {
        setLocalConfirmed(false);
      } else {
        throw new Error("Rejection failed");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to reject tool execution.");
    } finally {
      setRejecting(false);
    }
  };

  const showButtons = pendingApproval !== undefined && localConfirmed === null;

  const detected = detectToolResultStatus(result);
  const badgeStatus = showButtons ? "waiting" : deriveBadgeStatus(status, detected);
  const elapsed = useElapsedSeconds(toolCallId, badgeStatus === "running");

  // Inline header annotation — populated for both `error` and
  // `warning` badge states (both carry an `isError: true` envelope
  // with a `message`). A plain `done` result that happens to have an
  // `error` field — e.g. a SQL query that legitimately returns rows
  // with an "error" column — must NOT show this banner, so we gate on
  // the badge state, not on the raw payload.
  const annotated = badgeStatus === "error" || badgeStatus === "warning";
  const headerMessage = annotated ? extractErrorMessage(result) : null;

  // Default collapsed for both success and failure paths. The badge
  // colour signals the outcome; the LLM's narration explains why; the
  // failure header below surfaces the diagnostic without forcing a
  // visual jump. Users who want raw args/result click to expand.
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
      {/* Header row — always visible. Failure message is inlined after
          the elapsed timer and truncates against the badge so a long
          error never wraps; the full text is on the `title` tooltip and
          in the expanded result view. */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-foreground">
          {name}
        </span>
        {/* History replay always lands here with elapsed === "0s"
            because `useElapsedSeconds` uses Date.now() for both
            startedAt and completedAt, which collapse together on
            instant SSE replay. Hiding the span on "0s" doubles as the
            cleanest replay-vs-live discriminator AND filters out the
            sub-second flash of "0s" on a fresh live tool call before
            the 1s interval fires. */}
        {elapsed !== "0s" && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            · {elapsed}
          </span>
        )}
        {annotated && headerMessage ? (
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
            title={headerMessage}
          >
            · {headerMessage}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ToolStatusBadge status={badgeStatus} />
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </button>

      {/* Expanded — full args + result JSON for debugging. */}
      {expanded && (
        <>
          <div className="border-t border-border px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Arguments
            </div>
            <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
              {formatParameters(parameters)}
            </pre>
          </div>
          {result !== undefined && (
            <div className="border-t border-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Result
              </div>
              <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
                {result}
              </pre>
            </div>
          )}
        </>
      )}

      {/* Tool approval section (visible even when card is collapsed) */}
      {showButtons && (
        <div className="border-t border-border px-3 py-3 bg-amber-500/5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              Requires manual approval
            </span>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                disabled={approving || rejecting}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                )}
                onClick={handleApprove}
              >
                {approving ? "Approving..." : "Approve"}
              </button>
              <button
                type="button"
                disabled={approving || rejecting}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors",
                  "bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
                )}
                onClick={handleReject}
              >
                {rejecting ? "Rejecting..." : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {localConfirmed !== null && (
        <div className="border-t border-border px-3 py-2 bg-muted/30">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {localConfirmed ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                <span>Approved</span>
              </>
            ) : (
              <>
                <X className="h-3.5 w-3.5 text-destructive" />
                <span>Rejected</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
