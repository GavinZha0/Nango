"use client";

/**
 * ChoiceSelector — HITL render component for `ask_user_choice`.
 *
 * - **executing**: clickable option chips
 * - **complete**: all options visible, selected one highlighted with
 *   a green check, all buttons disabled
 *
 * Cancellation on agent-switch is handled at the hook level
 * (useInteractiveTools), NOT here — component-level cleanup fires
 * prematurely in React 19 strict mode.
 */

import { Check } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import type { HitlRenderProps } from "./types";

/** Tool parameter shape for `ask_user_choice`. */
export type ChoiceArgs = {
  question: string;
  options: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
};

export function ChoiceSelector(
  props: HitlRenderProps<ChoiceArgs>,
): ReactElement | null {
  const { args, status } = props;
  const respond = status === "executing" ? props.respond : undefined;
  const result = status === "complete" ? props.result : undefined;

  if (status === "inProgress") {
    return (
      <div className="my-2 h-16 animate-pulse rounded-lg border border-border bg-muted/30" />
    );
  }

  // Options available in both executing and complete states.
  const options = args.options;

  if (status === "executing" && respond && options) {
    return (
      <div className="my-2 rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-sm font-medium">{args.question}</p>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={args.question}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={cn(
                "rounded-full border border-border px-3 py-1 text-sm",
                "hover:bg-accent focus-visible:outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring",
              )}
              title={opt.description}
              onClick={() => respond(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (status === "complete") {
    // When options are available, render all chips with the selected
    // one highlighted — much better UX than a plain text summary.
    if (options) {
      return (
        <div className="my-2 rounded-lg border border-border bg-muted/50 p-3">
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            {args.question ?? "Selection"}
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Completed selection">
            {options.map((opt) => {
              const isSelected = opt.value === result;
              return (
                <span
                  key={opt.value}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm",
                    isSelected
                      ? "border-emerald-500/50 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300"
                      : "border-border text-muted-foreground opacity-50",
                  )}
                >
                  {isSelected && <Check className="h-3 w-3" />}
                  {opt.label}
                </span>
              );
            })}
          </div>
        </div>
      );
    }

    // Fallback when options are not available (Partial args in complete state).
    return (
      <div className="my-2 rounded-lg border border-border bg-muted/50 p-3 text-sm">
        {args.question ?? "Selection"} →{" "}
        <span className="font-medium">{result}</span>
      </div>
    );
  }

  return null;
}
