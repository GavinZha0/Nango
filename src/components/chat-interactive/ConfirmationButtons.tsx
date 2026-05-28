"use client";

/**
 * ConfirmationButtons — HITL render component for `ask_user_confirmation`.
 *
 * Displays Approve / Reject buttons while executing; shows the
 * outcome after completion.
 *
 * Cancellation on agent-switch is handled at the hook level
 * (useInteractiveTools), NOT here.
 */

import { Check, X } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import type { HitlRenderProps } from "./types";

/** Tool parameter shape for `ask_user_confirmation`. */
export type ConfirmArgs = {
  message: string;
  confirmLabel?: string;
  rejectLabel?: string;
};

/** Shape returned by `respond()` and later parsed from `result`. */
interface ConfirmResult {
  confirmed: boolean;
}

/** Safely parse the JSON result string. */
function parseConfirmResult(raw: string | undefined): ConfirmResult | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "confirmed" in parsed) {
      return parsed as ConfirmResult;
    }
    return null;
  } catch {
    return null;
  }
}

export function ConfirmationButtons(
  props: HitlRenderProps<ConfirmArgs>,
): ReactElement | null {
  const { args, status } = props;
  const respond = status === "executing" ? props.respond : undefined;
  const result = status === "complete" ? props.result : undefined;

  if (status === "inProgress") {
    return (
      <div className="my-2 h-16 animate-pulse rounded-lg border border-border bg-muted/30" />
    );
  }

  if (status === "executing" && respond) {
    return (
      <div className="my-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
        <p className="mb-2 text-sm">{args.message}</p>
        <div className="flex gap-2" role="group" aria-label="Confirmation">
          <button
            type="button"
            className={cn(
              "rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            onClick={() => respond({ confirmed: true })}
          >
            {args.confirmLabel ?? "Approve"}
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md bg-secondary px-3 py-1 text-sm text-secondary-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            onClick={() => respond({ confirmed: false })}
          >
            {args.rejectLabel ?? "Reject"}
          </button>
        </div>
      </div>
    );
  }

  if (status === "complete") {
    const parsed = parseConfirmResult(result);
    const confirmed = parsed?.confirmed ?? false;
    const approveLabel = args.confirmLabel ?? "Approve";
    const rejectLabel = args.rejectLabel ?? "Reject";
    return (
      <div className="my-2 rounded-lg border border-border bg-muted/50 p-3">
        <p className="mb-2 text-sm text-muted-foreground">{args.message}</p>
        <div className="flex gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm",
              confirmed
                ? "border border-emerald-500/50 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground opacity-50",
            )}
          >
            {confirmed && <Check className="h-3 w-3" />}
            {approveLabel}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm",
              !confirmed
                ? "border border-destructive/50 bg-destructive/10 font-medium text-destructive"
                : "text-muted-foreground opacity-50",
            )}
          >
            {!confirmed && <X className="h-3 w-3" />}
            {rejectLabel}
          </span>
        </div>
      </div>
    );
  }

  return null;
}
