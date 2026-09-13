"use client";

import { useState, type ReactElement } from "react";
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { z } from "zod";
import type { AbstractAgent } from "@ag-ui/client";

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
}: ErrorActivityCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const errorMessage = content?.message || "Execution failed";
  const errorDetails = content?.error;

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
