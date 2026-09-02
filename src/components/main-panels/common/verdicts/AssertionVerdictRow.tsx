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
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  const reasonText = verdict.reason || verdict.feedback;

  const hasExpandableDetails =
    Boolean(reasonText) || verdict.details !== undefined;

  const toggleExpand = (): void => {
    if (hasExpandableDetails) {
      setExpanded((prev) => !prev);
    }
  };

  const titleText = formatVerdictTitle(verdict, spec);

  // 3-color dot indicators for LLM Judge
  const isUnexpectation = Boolean(
    verdict.unexpectation ||
      (spec && "unexpectation" in spec && spec.unexpectation),
  );
  const isReference = Boolean(
    (verdict.reference && !verdict.expectation) ||
      (spec && "reference" in spec && spec.reference && !("expectation" in spec && spec.expectation)),
  );

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

          {/* Three-color dot for LLM Judge */}
          {isLlmJudge && (
            <span
              className={cn(
                "h-2 w-2 rounded-full shrink-0 shadow-xs",
                isUnexpectation
                  ? "bg-rose-500"
                  : isReference
                    ? "bg-sky-500"
                    : "bg-emerald-500",
              )}
              title={
                isUnexpectation
                  ? "Unexpectation / Forbidden"
                  : isReference
                    ? "Reference Context"
                    : "Expectation"
              }
            />
          )}

          {/* Title description */}
          <span className="font-mono text-[11px] truncate text-foreground/90 flex-1">
            {titleText}
          </span>

          {/* Inline actual value on failure for deterministic assertions */}
          {!isOk && !isLlmJudge && verdict.actual !== undefined && (
            <span className="shrink-0 text-red-500/90 dark:text-red-400/90 font-mono text-[10px]">
              ({formatValue(verdict.actual)})
            </span>
          )}

          {/* Score for LLM Judge */}
          {isLlmJudge && verdict.score !== undefined && verdict.score !== null && (
            <span className="font-mono text-[10px] text-muted-foreground shrink-0 tabular-nums px-1 py-0.5 rounded bg-muted/30 border border-border/20">
              {verdict.score}
            </span>
          )}

          {hasExpandableDetails && (
            <button
              type="button"
              className="text-muted-foreground/60 hover:text-foreground p-0.5 rounded transition-transform shrink-0"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expandable details: clean reason text */}
      {expanded && hasExpandableDetails && (
        <div className="border-t border-border/30 bg-muted/20 px-3 py-2 text-xs border-border/40">
          {reasonText && (
            <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap text-[11px] font-sans">
              {reasonText}
            </p>
          )}

          {!reasonText && verdict.details !== undefined && (
            <div className="font-mono text-[10px]">
              <span className="text-muted-foreground">Details: </span>
              <pre className="mt-0.5 overflow-x-auto text-muted-foreground bg-background/50 p-1 rounded border border-border/20 text-[10px]">
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
    const verdictText = verdict.expectation || verdict.unexpectation || verdict.reference;
    if (verdictText) return verdictText;
    if (spec) {
      if ("expectation" in spec && spec.expectation) return spec.expectation;
      if ("unexpectation" in spec && spec.unexpectation) return spec.unexpectation;
      if ("reference" in spec && spec.reference) return spec.reference;
    }
    return "LLM Judge";
  }

  if (spec) {
    if (spec.type === "js_expression") return spec.expression;
    if (spec.type === "jsonpath") {
      const path = verdict.path ?? spec.path ?? "";
      const op = spec.operator ?? "==";
      const expected = verdict.expected !== undefined ? verdict.expected : spec.expected;
      if (op === "exists") return `${path || "path"} exists`;
      return `${path || "path"} ${op} ${formatValue(expected)}`;
    }
    if (spec.type === "json_schema") return "JSON Schema validation";
    if (spec.type === "tool_call") return `Tool: ${spec.toolName}`;
    if (spec.type === "metric") return `${spec.metric} ${spec.operator} ${spec.threshold}`;
  }

  if (verdict.type === "metric") {
    if (verdict.expected !== undefined) {
      return `${formatValue(verdict.expected)}`;
    }
    if (verdict.message) {
      return verdict.message
        .replace(/^Metric:\s*/i, "")
        .replace(/^Metric\s+/i, "");
    }
  }

  if (verdict.path) {
    if (verdict.expected !== undefined) {
      return `${verdict.path} == ${formatValue(verdict.expected)}`;
    }
    return verdict.path;
  }

  if (verdict.message) {
    return verdict.message
      .replace(/^JS Expression:\s*/i, "")
      .replace(/^Metric:\s*/i, "")
      .replace(/^Metric\s+/i, "");
  }

  return verdict.type;
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
