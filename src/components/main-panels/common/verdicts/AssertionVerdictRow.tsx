"use client";

/**
 * Reusable single assertion verdict row component.
 *
 * Renders:
 * - Deterministic assertion (JSONPath, Schema, JS, Tool Call, Metric) with clean status icon, title, and inline actual value on the right when failed.
 * - LLM Judge assertion with score badge (0-100), natural language expectation, and expandable model feedback reasoning.
 * - Error entry with amber alert icon, Error badge, and error details.
 *
 * Shared across Verification, Evaluation, and Web Auto modules.
 */

import { useState, type ReactNode } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AssertionResult, AssertionSpec } from "@/lib/assertions";

interface AssertionVerdictRowProps {
  verdict: AssertionResult;
  spec?: AssertionSpec;
}

export function AssertionVerdictRow({ verdict, spec }: AssertionVerdictRowProps): ReactNode {
  const [expanded, setExpanded] = useState<boolean>(false);
  const isErrorType = verdict.type === "error";
  const isLlmJudge =
    verdict.type === "llm_judge" ||
    verdict.type === "expectation" ||
    verdict.type === "llm_expectation";

  const isOk = verdict.ok;

  const hasExpandableDetails =
    Boolean(verdict.feedback) ||
    verdict.details !== undefined;

  const toggleExpand = (): void => {
    if (hasExpandableDetails) {
      setExpanded((prev) => !prev);
    }
  };

  const titleText = formatVerdictTitle(verdict, spec);

  return (
    <li className="rounded border border-border/40 bg-background/50 text-xs overflow-hidden transition-colors">
      <div
        className={`flex items-center justify-between gap-2 px-2.5 py-1.5 ${
          hasExpandableDetails ? "cursor-pointer hover:bg-muted/30" : ""
        }`}
        onClick={toggleExpand}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Status icon */}
          {isErrorType ? (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          ) : isOk ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-rose-500 shrink-0" />
          )}

          {/* LLM Judge badge */}
          {isLlmJudge && (
            <Badge
              variant="outline"
              className="text-[9px] px-1 py-0 border-amber-500/40 text-amber-500 bg-amber-500/10 gap-0.5 shrink-0"
            >
              <Sparkles className="h-2 w-2" /> LLM
            </Badge>
          )}

          {/* Score badge for LLM Judge */}
          {isLlmJudge && verdict.score !== undefined && (
            <Badge
              variant="outline"
              className={`text-[9px] px-1 py-0 font-mono font-semibold shrink-0 ${
                verdict.score >= 70
                  ? "border-emerald-500/40 text-emerald-500 bg-emerald-500/10"
                  : "border-rose-500/40 text-rose-500 bg-rose-500/10"
              }`}
            >
              {verdict.score}/100
            </Badge>
          )}

          {/* Title description */}
          <span className="font-mono text-[11px] truncate text-foreground/90 flex-1">
            {verdict.index >= 0 && !isErrorType ? `#${verdict.index + 1} · ` : ""}
            {titleText}
          </span>

          {/* Inline actual value on failure */}
          {!isOk && verdict.actual !== undefined && (
            <span className="shrink-0 text-red-500/90 dark:text-red-400/90 font-mono text-[10px]">
              ({formatValue(verdict.actual)})
            </span>
          )}
        </div>

        {/* Expand toggle for feedback/details */}
        {hasExpandableDetails && (
          <button
            type="button"
            className="text-muted-foreground/60 hover:text-foreground shrink-0 p-0.5 ml-1"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => !prev);
            }}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Expandable details drawer */}
      {expanded && (
        <div className="border-t border-border/30 bg-muted/20 px-3 py-2 space-y-1.5 font-mono text-[10px]">
          {verdict.feedback && (
            <div className="space-y-0.5">
              <span className="text-muted-foreground flex items-center gap-1">
                <Sparkles className="h-2.5 w-2.5 text-amber-500" /> Model Feedback:
              </span>
              <p className="font-sans text-xs text-foreground/90 bg-muted/30 p-1.5 rounded border border-border/30 whitespace-pre-wrap">
                {verdict.feedback}
              </p>
            </div>
          )}

          {verdict.details !== undefined && (
            <div>
              <span className="text-muted-foreground">Details: </span>
              <pre className="mt-0.5 overflow-x-auto text-muted-foreground bg-background/50 p-1 rounded border border-border/20">
                {typeof verdict.details === "object"
                  ? JSON.stringify(verdict.details, null, 2)
                  : String(verdict.details)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function formatVerdictTitle(verdict: AssertionResult, spec?: AssertionSpec): string {
  if (verdict.type === "error") {
    const prefix = verdict.errorSource ? `[${verdict.errorSource}] ` : "";
    return `${prefix}${verdict.message ?? "Execution error"}`;
  }

  if (verdict.type === "llm_judge" || verdict.type === "expectation" || verdict.type === "llm_expectation") {
    return verdict.expectation ?? (spec && "expectation" in spec ? spec.expectation : "LLM Expectation");
  }

  if (spec) {
    if (spec.type === "js_expression") return spec.expression;
    if (spec.type === "jsonpath" || spec.type === "jsonpath_equals") {
      const path = verdict.path ?? spec.path ?? "";
      const op = "operator" in spec && spec.operator ? spec.operator : "==";
      const expected = verdict.expected !== undefined ? verdict.expected : ("expected" in spec ? spec.expected : undefined);
      if (op === "exists") return `${path || "path"} exists`;
      return `${path || "path"} ${op} ${formatValue(expected)}`;
    }
    if (spec.type === "json_schema") return "JSON Schema validation";
    if (spec.type === "tool_call") return `Tool: ${spec.toolName}`;
    if (spec.type === "metric") return `Metric: ${spec.metric} ${spec.operator} ${spec.threshold}`;
  }

  if (verdict.path) {
    if (verdict.expected !== undefined) {
      return `${verdict.path} == ${formatValue(verdict.expected)}`;
    }
    return verdict.path;
  }

  return verdict.message || verdict.type;
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
