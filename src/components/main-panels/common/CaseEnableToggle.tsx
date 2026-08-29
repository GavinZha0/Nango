"use client";

import type { ReactNode } from "react";
import { ToggleLeft, ToggleRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CaseEnableToggleProps {
  enabled: boolean;
  onToggle: (nextState: boolean) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}

/**
 * CaseEnableToggle — Unified inline icon toggle for enabling/disabling test cases.
 *
 * Uses compact vector switch icons:
 * - When enabled: displays ToggleRight (emerald green).
 * - When disabled: displays ToggleLeft (muted grey).
 *
 * Includes event stopPropagation to prevent row selection triggering.
 */
export function CaseEnableToggle({
  enabled,
  onToggle,
  disabled = false,
  className,
  title,
}: CaseEnableToggleProps): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) {
          onToggle(!enabled);
        }
      }}
      className={cn(
        "cursor-pointer rounded p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        enabled
          ? "text-emerald-500/80 hover:text-emerald-500"
          : "text-muted-foreground/40 hover:text-foreground",
        className,
      )}
      title={title ?? (enabled ? "Disable this case" : "Enable this case")}
      aria-label={enabled ? "Disable case" : "Enable case"}
    >
      {enabled ? (
        <ToggleRight className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <ToggleLeft className="h-3.5 w-3.5 shrink-0" />
      )}
    </button>
  );
}
