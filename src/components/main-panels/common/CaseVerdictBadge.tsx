"use client";

import type { ReactNode } from "react";
import {
  CircleCheck,
  CircleX,
  CircleAlert,
  CircleSlash,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type UniversalVerdictStatus =
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
 * Used across Verification, Evaluation, and Web Auto case lists.
 */
export function CaseVerdictBadge({
  status,
  className,
}: CaseVerdictBadgeProps): ReactNode {
  const iconClass = cn("h-3 w-3 shrink-0", className);

  switch (status) {
    case "passed":
      return <CircleCheck className={cn(iconClass, "text-emerald-500")} />;
    case "failed":
      return <CircleX className={cn(iconClass, "text-red-500")} />;
    case "errored":
      return <CircleAlert className={cn(iconClass, "text-amber-500")} />;
    case "timeout":
      return <Clock className={cn(iconClass, "text-amber-500")} />;
    case "skipped":
    case "untested":
    case null:
    case undefined:
    default:
      return <CircleSlash className={cn(iconClass, "text-muted-foreground/40")} />;
  }
}
