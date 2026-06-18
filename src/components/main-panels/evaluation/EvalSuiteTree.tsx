"use client";

/**
 * EvalSuiteTree — left column of the evaluation main panel.
 *
 * Displays suites for the selected agent, each expandable to show
 * its cases. Wired to flat store model (suites + cases separate).
 */

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { EvalSuiteRow, EvalCaseRow } from "@/store/evaluation";

// Component

interface EvalSuiteTreeProps {
  suites: EvalSuiteRow[];
  casesBySuite: Record<string, EvalCaseRow[]>;
  selectedCaseId: number | null;
  onSelectCase: (caseId: number) => void;
  onRunSuite: (suiteId: string) => void;
  onEditSuite: (suiteId: string) => void;
  onDeleteSuite: (suiteId: string) => void;
  onDeleteCase: (caseId: number, suiteId: string) => void;
}

export function EvalSuiteTree({
  suites,
  casesBySuite,
  selectedCaseId,
  onSelectCase,
  onRunSuite,
  onEditSuite,
  onDeleteSuite,
  onDeleteCase,
}: EvalSuiteTreeProps): ReactNode {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggleCollapse(suiteId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(suiteId)) next.delete(suiteId);
      else next.add(suiteId);
      return next;
    });
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      {suites.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          No evaluation suites yet.
        </div>
      ) : (
        suites.map((suite) => {
          const isCollapsed = collapsed.has(suite.id);
          const cases = casesBySuite[suite.id] ?? [];
          return (
            <div key={suite.id} className="border-b border-border/40">
              {/* Suite header */}
              <div className="group flex items-center gap-1.5 bg-muted/30 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => toggleCollapse(suite.id)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-semibold">{suite.name}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      ({cases.length})
                    </span>
                  </div>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {suite.dimensionIds.length} dim
                  </span>
                </div>
                {!suite.enabled && (
                  <span title="Disabled"><CircleSlash className="h-3 w-3 shrink-0 text-muted-foreground" /></span>
                )}
                <button
                  type="button"
                  onClick={() => onEditSuite(suite.id)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteSuite(suite.id)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0"
                  onClick={() => onRunSuite(suite.id)}
                  title={suite.evaluatorAgentId ? "Run suite" : "Evaluator Agent is required to run"}
                  disabled={!suite.evaluatorAgentId}
                >
                  <Play className={cn("h-3 w-3", suite.evaluatorAgentId ? "fill-green-500 text-green-500" : "fill-muted-foreground text-muted-foreground")} />
                </Button>
              </div>

              {/* Case list */}
              {!isCollapsed && (
                <div>
                  {cases.map((c) => (
                    <div
                      key={c.id}
                      className={cn(
                        "group/case flex w-full items-center gap-2 px-3 py-1.5 transition-colors",
                        selectedCaseId === c.id
                          ? "bg-accent"
                          : "hover:bg-muted/30",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onSelectCase(c.id)}
                        className="min-w-0 flex-1 truncate text-left text-xs"
                      >
                        {c.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteCase(c.id, suite.id)}
                        className="shrink-0 opacity-0 group-hover/case:opacity-100 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </ScrollArea>
  );
}
