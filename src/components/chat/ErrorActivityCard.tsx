"use client";

import { useEffect, useReducer, useState, type ReactElement } from "react";
import { AlertCircle, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { z } from "zod";
import type { AbstractAgent } from "@ag-ui/client";

import { useCopilotKit } from "@/lib/copilot/client";
import { useRegenerate } from "@/hooks/useRegenerate";

export const errorActivityContentSchema = z.object({
  message: z.string(),
  error: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorActivityContent = z.infer<typeof errorActivityContentSchema>;

export interface ErrorActivityCardProps {
  activityType: string;
  content: ErrorActivityContent;
  message: { id: string; role?: string };
  agent: AbstractAgent | undefined;
}

export function ErrorActivityCard({
  content,
  message,
  agent,
}: ErrorActivityCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const regenerate = useRegenerate(agent);
  const { copilotkit } = useCopilotKit();
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  // The activity row is memoized by message identity and only re-renders
  // when this card's own state changes. Subscribe so the button disappears
  // once a newer message makes this error historical.
  useEffect(() => {
    if (!agent) return;
    const sub = copilotkit.subscribeToAgentWithOptions(
      agent,
      { onMessagesChanged: forceRender },
      {},
    );
    // A run may finalize (or prune its trailing message) between this
    // row's render and its effects, leaving no future notification to
    // re-evaluate against.
    forceRender();
    return () => sub.unsubscribe();
  }, [agent, copilotkit, forceRender]);

  const errorMessage = content?.message || "Execution failed";
  const errorDetails = content?.error;

  // Retry targets the most recent turn only — an older error card is
  // history, and retrying it would truncate the thread.
  //
  // `agent.isRunning` is deliberately NOT part of this gate: the client
  // clears it in a `finally` AFTER the finalize callbacks have run, so
  // no notification re-evaluates this row and the button stayed hidden
  // until an unrelated re-render (e.g. expanding). `useRegenerate`
  // guards an in-flight run itself.
  const canRetry =
    agent !== undefined && agent.messages.at(-1)?.id === message.id;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-destructive/30 bg-card">
      {/* Header row — single-line compact tool-card style (~36px height) */}
      <div
        onClick={() => setExpanded((prev) => !prev)}
        className="flex h-9 w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/40"
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="shrink-0 text-xs font-medium text-destructive">
          Error
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={errorMessage}
        >
          · {errorMessage}
        </span>
        {canRetry && (
          <button
            type="button"
            title="Retry"
            aria-label="Retry"
            onClick={(e) => {
              e.stopPropagation();
              regenerate(message);
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>

      {/* Expanded details drawer — simplified: only display error text */}
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          <pre className="max-h-64 overflow-auto rounded bg-muted/50 p-2 text-[11px] font-mono leading-relaxed text-foreground select-text whitespace-pre-wrap break-words">
            {errorDetails ? JSON.stringify(errorDetails, null, 2) : errorMessage}
          </pre>
        </div>
      )}
    </div>
  );
}
