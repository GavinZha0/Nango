"use client";

/**
 * Reusable list container for assertion verdicts.
 *
 * Renders:
 * - Header with total count, pass/fail filter, title, and test status badge.
 * - Optional tool call execution & audit summary bar (Evaluation).
 * - Unified 2-group collapsible structure:
 *     1. Deterministic Checks (passed/total)
 *     2. LLM Checks (passed/total)
 *   Both default expanded, auto-hiding empty groups.
 * - Evaluator Feedback text card when present.
 * - Empty state when no verdicts are available.
 *
 * Shared across Verification, Evaluation, and Web Auto modules.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssertionResult, AssertionSpec, ErrorEnvelope } from "@/lib/assertions";
import type { ToolCallSummary } from "@/lib/evaluation/types";
import { AssertionVerdictRow } from "./AssertionVerdictRow";

export interface AssertionVerdictListProps {
  verdicts?: readonly AssertionResult[] | null;
  assertions?: readonly AssertionSpec[];
  error?: ErrorEnvelope | null;
  feedback?: string | null;
  status?: string | null;
  subtitle?: ReactNode;
  toolCallSummary?: ToolCallSummary | null;
  title?: string;
  emptyText?: ReactNode;
  className?: string;
}

export function AssertionVerdictList({
  verdicts = [],
  assertions = [],
  error,
  feedback,
  status = "idle",
  subtitle,
  toolCallSummary,
  title = "Verdicts",
  emptyText = "No verdict yet.",
  className = "",
}: AssertionVerdictListProps): ReactNode {
  const [filterFailedOnly, setFilterFailedOnly] = useState<boolean>(false);
  const [detOpen, setDetOpen] = useState<boolean>(true);
  const [llmOpen, setLlmOpen] = useState<boolean>(true);

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

  // Skipped rows are "not evaluated", not failures
  const skippedCount = list.filter((r) => r.skipped === true).length;
  const passedCount = list.filter((r) => r.ok).length;
  const failedCount = list.length - passedCount - skippedCount;
  const hasContent = list.length > 0;

  // Partition into Deterministic vs LLM Checks
  const isLlmType = (r: AssertionResult): boolean =>
    r.type === "llm_dim" ||
    r.type === "llm_custom" ||
    r.type === "expectation" ||
    r.type === "llm_expectation" ||
    (r as { kind?: string }).kind === "expectation";

  const detItems = list.filter((r) => !isLlmType(r));
  const llmItems = list.filter((r) => isLlmType(r));

  const detPassed = detItems.filter((r) => r.ok).length;
  const detTotal = detItems.length;

  const llmPassed = llmItems.filter((r) => r.ok).length;
  const llmTotal = llmItems.length;

  const detVisible = filterFailedOnly
    ? detItems.filter((r) => !r.ok && r.skipped !== true)
    : detItems;
  const llmVisible = filterFailedOnly
    ? llmItems.filter((r) => !r.ok && r.skipped !== true)
    : llmItems;

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      {/* Header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-border/60 bg-muted/20 px-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
            {title}
          </span>
          {list.length > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono shrink-0">
              ({list.length})
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {subtitle}
          {/* Failed only filter toggle */}
          {failedCount > 0 && (
            <button
              type="button"
              className={cn(
                "text-[9px] px-1.5 py-0.5 rounded border transition-colors",
                filterFailedOnly
                  ? "border-rose-500/40 bg-rose-500/10 text-rose-500 font-semibold"
                  : "border-border/40 text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setFilterFailedOnly((prev) => !prev)}
            >
              {filterFailedOnly ? "Showing Failed" : `${failedCount} Failed`}
            </button>
          )}

          {/* Test Status Badge on Verdict Header */}
          {status && (
            <span
              className={cn(
                "text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 uppercase tracking-wider",
                status === "passed"
                  ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                  : status === "failed"
                    ? "bg-rose-500/10 text-rose-500 border border-rose-500/20"
                    : "bg-amber-500/10 text-amber-500 border border-amber-500/20",
              )}
            >
              {status === "errored" ? "ERROR" : status.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {/* List content */}
      <div className="flex flex-col min-h-0 flex-1 px-3 pb-2 pt-2 overflow-y-auto">
        {hasContent ? (
          <div className="space-y-3">
            {/* Tool audit summary line (Evaluation) */}
            {toolCallSummary && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground pb-2 border-b border-border/40 font-mono">
                <span>
                  Tools: <strong className="text-foreground">{toolCallSummary.totalCalls}</strong>
                  {toolCallSummary.totalDurationMs !== undefined && toolCallSummary.totalDurationMs > 0 && (
                    <span className="text-muted-foreground/80 font-normal">
                      {" "}({toolCallSummary.totalDurationMs >= 1000
                        ? `${(toolCallSummary.totalDurationMs / 1000).toFixed(1)}s`
                        : `${toolCallSummary.totalDurationMs}ms`})
                    </span>
                  )}
                </span>
                <span>·</span>
                <span className={toolCallSummary.failureCount > 0 ? "text-rose-500 font-semibold" : ""}>
                  Fail: {toolCallSummary.failureCount}
                </span>
                <span>·</span>
                <span className={toolCallSummary.blockedCount > 0 ? "text-amber-500 font-semibold" : ""}>
                  Blocked: {toolCallSummary.blockedCount}
                </span>
              </div>
            )}

            {/* Group 1: Deterministic Checks */}
            {detItems.length > 0 && (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => setDetOpen((prev) => !prev)}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground w-full text-left py-0.5 transition-colors"
                >
                  {detOpen ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span>
                    Deterministic Checks ({detPassed}/{detTotal})
                  </span>
                </button>

                {detOpen && (
                  detVisible.length > 0 ? (
                    <ul className="space-y-1">
                      {detVisible.map((r, i) => (
                        <AssertionVerdictRow
                          key={i}
                          verdict={r}
                          spec={assertions[r.index]}
                        />
                      ))}
                    </ul>
                  ) : filterFailedOnly ? (
                    <div className="text-[10px] text-muted-foreground font-mono pl-4 py-1">
                      No failed deterministic checks.
                    </div>
                  ) : null
                )}
              </div>
            )}

            {/* Group 2: LLM Checks */}
            {llmItems.length > 0 && (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => setLlmOpen((prev) => !prev)}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground w-full text-left py-0.5 transition-colors"
                >
                  {llmOpen ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span>
                    LLM Checks ({llmPassed}/{llmTotal})
                  </span>
                </button>

                {llmOpen && (
                  llmVisible.length > 0 ? (
                    <ul className="space-y-1">
                      {llmVisible.map((r, i) => (
                        <AssertionVerdictRow
                          key={i}
                          verdict={r}
                          spec={assertions[r.index]}
                        />
                      ))}
                    </ul>
                  ) : filterFailedOnly ? (
                    <div className="text-[10px] text-muted-foreground font-mono pl-4 py-1">
                      No failed LLM checks.
                    </div>
                  ) : null
                )}
              </div>
            )}

            {/* Filtered empty state */}
            {filterFailedOnly && detVisible.length === 0 && llmVisible.length === 0 && (
              <div className="flex h-12 items-center justify-center text-xs text-muted-foreground font-mono">
                No failed assertions.
              </div>
            )}

            {/* Feedback section inside Verdicts */}
            {feedback && (
              <div className="space-y-1.5 pt-2 border-t border-border/40 mt-3">
                <span className="text-[11px] font-semibold text-muted-foreground">Feedback</span>
                <div className="text-xs rounded-md border border-border/40 bg-muted/20 p-2.5 leading-relaxed whitespace-pre-wrap text-muted-foreground font-sans">
                  {feedback}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 h-full flex-col justify-between">
            <div className="flex flex-1 items-center justify-center p-3 text-xs text-muted-foreground">
              {emptyText}
            </div>
            {feedback && (
              <div className="space-y-1.5 pt-2 border-t border-border/40 mt-3">
                <span className="text-[11px] font-semibold text-muted-foreground">Feedback</span>
                <div className="text-xs rounded-md border border-border/40 bg-muted/20 p-2.5 leading-relaxed whitespace-pre-wrap text-muted-foreground font-sans">
                  {feedback}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
