"use client";

import React, { useState, type ComponentType, type ReactElement } from "react";
import { Check, X } from "lucide-react";
import { useWorkspaceStore } from "@/store/workspace";
import { cn } from "@/lib/utils";

export function withToolApproval<P extends object>(
  WrappedComponent: ComponentType<P>
): (props: P) => ReactElement {
  return function ToolApprovalWrapper(props: P): ReactElement {
    const { name, parameters, toolCallId } = props as unknown as { name: string; parameters: unknown; toolCallId: string };

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

    return (
      <div className="relative flex flex-col w-full">
        <WrappedComponent {...props} />

        {/* Tool approval section (visible even when card is collapsed) */}
        {showButtons && (
          <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-card">
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
          </div>
        )}

        {localConfirmed !== null && (
          <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-card">
            <div className="px-3 py-2 bg-muted/30">
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
          </div>
        )}
      </div>
    );
  };
}
