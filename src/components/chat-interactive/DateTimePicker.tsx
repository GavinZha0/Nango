"use client";

/**
 * DateTimePicker — HITL render component for `ask_user_datetime`.
 *
 * Uses native `<input type="datetime-local">` for zero-dependency
 * date+time selection. If more polish is needed later, swap the
 * native input for react-day-picker + shadcn Calendar.
 *
 * - **executing**: one or two datetime inputs depending on `mode`
 * - **complete**: shows the selected datetime(s) with a check icon
 *
 * Cancellation on agent-switch is handled at the hook level
 * (useInteractiveTools), NOT here.
 */

import { Calendar, Check } from "lucide-react";
import { useId, useState, type ReactElement } from "react";

import { cn } from "@/lib/utils";
import type { HitlRenderProps } from "./types";

/** Tool parameter shape for `ask_user_datetime`. */
export type DateTimeArgs = {
  prompt: string;
  mode?: "single" | "range";
  defaultStart?: string;
  defaultEnd?: string;
};

/** Shape returned by `respond()`. */
type DateTimeResult = {
  start: string;
  end?: string;
};

/** Format ISO-ish string to local display. */
function formatDisplay(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Convert ISO string to `datetime-local` input value (YYYY-MM-DDTHH:mm). */
function toInputValue(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

/** Parse the JSON result string safely. */
function parseResult(raw: string | undefined): DateTimeResult | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "start" in parsed) {
      return parsed as DateTimeResult;
    }
    return null;
  } catch {
    return null;
  }
}

export function DateTimePicker(
  props: HitlRenderProps<DateTimeArgs>,
): ReactElement | null {
  const { args, status } = props;
  const respond = status === "executing" ? props.respond : undefined;
  const result = status === "complete" ? props.result : undefined;

  const isRange = (args.mode ?? "single") === "range";
  const startId = useId();
  const endId = useId();

  const [startVal, setStartVal] = useState(() => toInputValue(args.defaultStart));
  const [endVal, setEndVal] = useState(() => toInputValue(args.defaultEnd));

  if (status === "inProgress") {
    return (
      <div className="my-2 h-20 animate-pulse rounded-lg border border-border bg-muted/30" />
    );
  }

  if (status === "executing" && respond) {
    const canSubmit = startVal.length > 0 && (!isRange || endVal.length > 0);
    const hasError = isRange && startVal && endVal && startVal >= endVal;

    const submit = (): void => {
      if (!canSubmit || hasError) return;
      const payload: DateTimeResult = { start: new Date(startVal).toISOString() };
      if (isRange) payload.end = new Date(endVal).toISOString();
      respond(payload);
    };

    return (
      <div className="my-2 rounded-lg border border-border bg-card p-3">
        {/* Row 1 — prompt (dynamic, LLM-provided). */}
        <p className="mb-3 text-sm font-medium">{args.prompt}</p>
        {/* Row 2 — input(s) + Confirm button on a single line.
            `items-end` keeps the Confirm button aligned with the input
            baseline even when range mode adds a "Start" / "End" label
            above each input (the labels add extra height to those
            wrappers but not to the button). */}
        <div
          className={cn(
            "flex gap-3 items-end",
            isRange ? "flex-col sm:flex-row" : "",
          )}
        >
          {/* Start datetime */}
          <div className="flex-1">
            {isRange && (
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor={startId}>
                Start
              </label>
            )}
            <input
              id={startId}
              type="datetime-local"
              className={cn(
                "w-full rounded-md border border-input bg-background px-3 py-1.5",
                "text-sm text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "[color-scheme:dark]",
              )}
              value={startVal}
              onChange={(e) => setStartVal(e.target.value)}
              autoFocus
            />
          </div>
          {/* End datetime (range mode only) */}
          {isRange && (
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor={endId}>
                End
              </label>
              <input
                id={endId}
                type="datetime-local"
                className={cn(
                  "w-full rounded-md border border-input bg-background px-3 py-1.5",
                  "text-sm text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "[color-scheme:dark]",
                )}
                value={endVal}
                onChange={(e) => setEndVal(e.target.value)}
                min={startVal || undefined}
              />
            </div>
          )}
          {/* Submit — inline at the end of the input row. `shrink-0`
              prevents flex from squeezing the button when range mode
              adds a second input on a narrow lane. */}
          <button
            type="button"
            className={cn(
              "shrink-0 rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground",
              "disabled:opacity-50 focus-visible:outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring",
            )}
            disabled={!canSubmit || !!hasError}
            onClick={submit}
          >
            Confirm
          </button>
        </div>
        {/* Validation error — only rendered when range start ≥ end. */}
        {hasError && (
          <p className="mt-1 text-xs text-destructive">End time must be after start time</p>
        )}
      </div>
    );
  }

  if (status === "complete") {
    const parsed = parseResult(result);
    if (parsed) {
      return (
        <div className="my-2 rounded-lg border border-border bg-muted/50 p-3">
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            {args.prompt ?? "Date/time"}
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              <Calendar className="h-3 w-3" />
              {isRange ? "Start: " : ""}
              {formatDisplay(parsed.start)}
              <Check className="h-3 w-3" />
            </span>
            {parsed.end && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <Calendar className="h-3 w-3" />
                End: {formatDisplay(parsed.end)}
                <Check className="h-3 w-3" />
              </span>
            )}
          </div>
        </div>
      );
    }

    // Fallback for missing/unparseable result
    return (
      <div className="my-2 rounded-lg border border-border bg-muted/50 p-3 text-sm">
        {args.prompt ?? "Date/time"} → <span className="font-medium">{result}</span>
      </div>
    );
  }

  return null;
}
