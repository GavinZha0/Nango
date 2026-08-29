"use client";

import type { ReactNode } from "react";
import {
  Check,
  X,
  AlertTriangle,
  Clock,
  Loader2,
  Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type UniversalVerdictStatus =
  | "running"
  | "passed"
  | "failed"
  | "errored"
  | "timeout"
  | "skipped"
  | "untested"
  | null
  | undefined;

export interface CaseVerdictBadgeProps {
  status: UniversalVerdictStatus;
  className?: string;
}

/**
 * CaseVerdictBadge — Unified status indicator icon for test case execution outcomes.
 *
 * Uses clear, non-enclosed status symbols (Check / X / AlertTriangle / Minus)
 * to avoid visual collision with row-level enable/disable toggles.
 */
export function CaseVerdictBadge({
  status,
  className,
}: CaseVerdictBadgeProps): ReactNode {
  const iconClass = cn("h-3.5 w-3.5 shrink-0", className);

  switch (status) {
    case "running":
      return <Loader2 className={cn(iconClass, "animate-spin text-sky-500")} />;
    case "passed":
      return <Check className={cn(iconClass, "text-emerald-500 stroke-[2.5]")} />;
    case "failed":
      return <X className={cn(iconClass, "text-red-500 stroke-[2.5]")} />;
    case "errored":
      return <AlertTriangle className={cn(iconClass, "text-amber-500")} />;
    case "timeout":
      return <Clock className={cn(iconClass, "text-amber-500")} />;
    case "skipped":
    case "untested":
    case null:
    case undefined:
    default:
      return <Minus className={cn(iconClass, "text-muted-foreground/35")} />;
  }
}
