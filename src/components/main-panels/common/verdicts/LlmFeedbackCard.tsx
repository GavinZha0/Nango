"use client";

/**
 * Reusable card for displaying LLM evaluator feedback & reasoning summary.
 *
 * Shared across Evaluation and Web Auto modules.
 */

import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface LlmFeedbackCardProps {
  feedback?: string | null;
  score?: number | null;
  title?: string;
  className?: string;
}

export function LlmFeedbackCard({
  feedback,
  score,
  title = "Model Evaluation Feedback",
  className = "",
}: LlmFeedbackCardProps): ReactNode {
  if (!feedback && score === undefined) return null;

  return (
    <div
      className={`rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2 text-xs ${className}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-amber-500">
          <Sparkles className="h-3.5 w-3.5" />
          <span>{title}</span>
        </div>
        {score !== null && score !== undefined && (
          <Badge
            variant="outline"
            className={`text-[10px] font-mono font-semibold ${
              score >= 70
                ? "border-emerald-500/40 text-emerald-500 bg-emerald-500/10"
                : "border-rose-500/40 text-rose-500 bg-rose-500/10"
            }`}
          >
            Score: {score}/100
          </Badge>
        )}
      </div>

      {feedback && (
        <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed text-[11px] bg-background/50 p-2 rounded border border-border/20">
          {feedback}
        </p>
      )}
    </div>
  );
}
