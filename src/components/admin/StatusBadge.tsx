"use client";

/**
 * StatusBadge — coloured chip for a single `entity_run.status` value.
 * Shared between the admin run list, thread list, run detail header,
 * and the thread summary card.
 *
 * Colour mapping is intentionally aligned with the priority order in
 * `src/lib/runner/thread-metrics.ts::STATUS_PRIORITY`: failed = red,
 * running = blue, terminal-cancelled = muted, succeeded = emerald,
 * everything else falls through to amber so unknown / awaiting states
 * stand out.
 */

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }): ReactNode {
  const tone =
    status === "succeeded"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : status === "failed"
        ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
        : status === "running"
          ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          : status === "cancelled"
            ? "border-muted-foreground/40 bg-muted text-muted-foreground"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return (
    <Badge variant="outline" className={cn("font-mono text-[10px]", tone)}>
      {status}
    </Badge>
  );
}
