"use client";

import { type ReactNode } from "react";
import { AlertCircle, X } from "lucide-react";

import { useWorkspaceStore } from "@/store/workspace";

/**
 * ChatErrorBanner — sticky inline error banner at the top of the chat area.
 */
export function ChatErrorBanner(): ReactNode {
  const lastChatError = useWorkspaceStore((s) => s.lastChatError);
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const clearChatError = useWorkspaceStore((s) => s.clearChatError);

  // Drop stale errors that belong to a different agent. The store's
  // `setActiveAgent` reducer also clears the error on agent switch,
  // but this guard makes the component correct even if a future caller
  // mutates `activeAgentId` without going through that reducer.
  if (!lastChatError || lastChatError.agentId !== activeAgentId) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 leading-snug break-words">
        {lastChatError.message}
      </p>
      <button
        type="button"
        onClick={clearChatError}
        aria-label="Dismiss error"
        className="shrink-0 rounded p-0.5 text-destructive/70 hover:bg-destructive/20 hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
