"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/store/workspace";

export interface ToolApprovalState {
  showButtons: boolean;
  approving: boolean;
  rejecting: boolean;
  localConfirmed: boolean | null;
  handleApprove: () => Promise<void>;
  handleReject: () => Promise<void>;
}

export function useToolApproval(
  toolCallId: string | undefined,
  name: string,
  parameters: unknown
): ToolApprovalState {
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

  const pendingApproval = pendingApprovals.find((a) =>
    a.toolCallId
      ? a.toolCallId === toolCallId
      : a.toolName === name && matchesArgs(a.args, parameters)
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
      toast.error("Failed to approve tool execution.");
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
      toast.error("Failed to reject tool execution.");
    } finally {
      setRejecting(false);
    }
  };

  const showButtons = pendingApproval !== undefined && localConfirmed === null;

  return {
    showButtons,
    approving,
    rejecting,
    localConfirmed,
    handleApprove,
    handleReject,
  };
}

export function ToolApprovalButtons({ state }: { state: ToolApprovalState }) {
  if (!state.showButtons) return null;
  return (
    <div className="flex gap-2 shrink-0">
      <button
        type="button"
        disabled={state.approving || state.rejecting}
        className={cn(
          "flex items-center cursor-pointer gap-1.5 rounded bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors",
          (state.approving || state.rejecting) && "opacity-50 cursor-not-allowed"
        )}
        onClick={(e) => {
          e.stopPropagation();
          state.handleApprove();
        }}
      >
        <Check className="h-3 w-3 text-emerald-500" />
        {state.approving ? "Approving..." : "Approve"}
      </button>
      <button
        type="button"
        disabled={state.approving || state.rejecting}
        className={cn(
          "flex items-center cursor-pointer gap-1.5 rounded bg-secondary px-2.5 py-1 text-[10px] font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors",
          (state.approving || state.rejecting) && "opacity-50 cursor-not-allowed"
        )}
        onClick={(e) => {
          e.stopPropagation();
          state.handleReject();
        }}
      >
        <X className="h-3 w-3 text-destructive" />
        {state.rejecting ? "Rejecting..." : "Reject"}
      </button>
    </div>
  );
}

export function ToolApprovalBadge({ state }: { state: ToolApprovalState }) {
  if (state.localConfirmed === null) return null;
  if (state.localConfirmed) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground border border-border bg-background px-1.5 py-0.5 rounded shrink-0">
        <Check className="h-3 w-3 text-emerald-500" /> Approved
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground border border-border bg-background px-1.5 py-0.5 rounded shrink-0">
      <X className="h-3 w-3 text-destructive" /> Rejected
    </span>
  );
}
