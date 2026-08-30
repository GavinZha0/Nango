"use client";

/**
 * Reusable list container for assertion verdicts.
 *
 * Renders:
 * - Header with total count, pass/fail filter, and title.
 * - List of AssertionVerdictRow components (including synthesized error items).
 * - Empty state when no verdicts are available.
 *
 * Shared across Verification, Evaluation, and Web Auto modules.
 */

import { useState, type ReactNode } from "react";
import type { AssertionResult, AssertionSpec, ErrorEnvelope } from "@/lib/assertions";
import { AssertionVerdictRow } from "./AssertionVerdictRow";

export interface AssertionVerdictListProps {
  verdicts?: readonly AssertionResult[] | null;
  assertions?: readonly AssertionSpec[];
  error?: ErrorEnvelope | null;
  title?: string;
  emptyText?: string;
  className?: string;
}

export function AssertionVerdictList({
  verdicts = [],
  assertions = [],
  error,
  title = "Verdicts",
  emptyText = "No verdict yet.",
  className = "",
}: AssertionVerdictListProps): ReactNode {
  const [filterFailedOnly, setFilterFailedOnly] = useState<boolean>(false);
  const rawList = verdicts ?? [];

  // If top-level error is present and not already represented in the list, synthesize an error row
  const list: AssertionResult[] = [...rawList];
  if (
    error &&
    error.source !== "assertion" &&
    !list.some((r) => r.type === "error" || (r.message === error.message && !r.ok))
  ) {
    list.push({
      index: list.length,
      type: "error",
      ok: false,
      errorSource: error.source,
      message: error.message,
      details: error.details,
    });
  }

  const filtered = filterFailedOnly
    ? list.filter((r) => !r.ok)
    : list;

  const passedCount = list.filter((r) => r.ok).length;
  const failedCount = list.length - passedCount;
  const hasContent = list.length > 0;

  return (
    <div className={`flex min-h-0 flex-col overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-border/60 bg-muted/20 px-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          {list.length > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              ({list.length})
            </span>
          )}
        </div>

        {/* Failed only filter toggle */}
        {failedCount > 0 && (
          <button
            type="button"
            className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
              filterFailedOnly
                ? "border-rose-500/40 bg-rose-500/10 text-rose-500 font-semibold"
                : "border-border/40 text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setFilterFailedOnly((prev) => !prev)}
          >
            {filterFailedOnly ? "Showing Failed" : `${failedCount} Failed`}
          </button>
        )}
      </div>

      {/* List content */}
      <div className="min-h-0 flex-1 px-3 pb-2 pt-2 overflow-y-auto">
        {hasContent ? (
          <div className="space-y-2">
            {/* Verdict rows */}
            {filtered.length > 0 ? (
              <ul className="space-y-1">
                {filtered.map((r, i) => (
                  <AssertionVerdictRow
                    key={i}
                    verdict={r}
                    spec={assertions[r.index]}
                  />
                ))}
              </ul>
            ) : list.length > 0 && filterFailedOnly ? (
              <div className="flex h-16 items-center justify-center text-xs text-muted-foreground font-mono">
                No failed assertions.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}
