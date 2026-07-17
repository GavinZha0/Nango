"use client";

/**
 * EvalSuiteTree — left column of the evaluation main panel.
 *
 * Displays suites for the selected agent, each expandable to show
 * its cases. Wired to flat store model (suites + cases separate).
 */

import { useState, useMemo, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Loader2,
  SquarePen,
  Play,
  Trash2,
  CircleCheck,
  CircleX,
  CircleAlert,
  SquarePlus,
  Globe,
  Lock,
} from "lucide-react";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import { useRole } from "@/hooks/useRole";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { alphabeticCompare } from "@/lib/utils/sort";
import { useWorkspaceStore } from "@/store/workspace";
import type { EvalSuiteRow, EvalCaseRow } from "@/store/evaluation";
import type { EvaluationRunLiveState } from "@/hooks/useEvaluationRunStream";

export interface CaseVerdict {
  status: "running" | "passed" | "failed" | "errored";
}

function VerdictBadge({ verdict }: { verdict: CaseVerdict | undefined }): ReactNode {
  if (!verdict) {
    return <CircleSlash className="h-3 w-3 text-muted-foreground/35" />;
  }
  switch (verdict.status) {
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin text-sky-500" />;
    case "passed":
      return <CircleCheck className="h-3 w-3 text-emerald-500" />;
    case "failed":
      return <CircleX className="h-3 w-3 text-red-500" />;
    case "errored":
      return <CircleAlert className="h-3 w-3 text-amber-500" />;
  }
}

// Component

interface EvalSuiteTreeProps {
  suites: EvalSuiteRow[];
  casesBySuite: Record<string, EvalCaseRow[]>;
  selectedCaseId: number | null;
  liveRun: EvaluationRunLiveState;
  runningSuiteId: string | null;
  verdictByCaseId: ReadonlyMap<number, CaseVerdict>;
  onSelectCase: (caseId: number) => void;
  onRunSuite: (suiteId: string) => void;
  onEditSuite: (suiteId: string) => void;
  onDeleteSuite: (suiteId: string) => void;
  onDeleteCase: (caseId: number, suiteId: string) => void;
  onCreateCase: (suiteId: string) => void;
  onEditCase: (c: EvalCaseRow) => void;
  onToggleVisibility: (suiteId: string, next: "public" | "private") => void;
}

function SuiteActions(
  {
    suite,
    onEditSuite,
    onDeleteSuite,
    onToggleVisibility,
    onRunSuite,
    isSuiteRunning,
  }: { 
    suite: EvalSuiteRow; 
    onEditSuite: (suiteId: string) => void; 
    onDeleteSuite: (suiteId: string) => void; 
    onToggleVisibility: (suiteId: string, next: "public" | "private") => void;
    onRunSuite: (suiteId: string) => void;
    isSuiteRunning: boolean;
  }): ReactNode {
    const isPublic = suite.visibility === "public";
    const { canDelete, canChangeVisibility } = useResourcePermissions({source: "local" as const, visibility: suite.visibility, createdBy: suite.createdBy});
    return (
      <div className={cn(
        "flex items-center gap-0.5 shrink-0 transition-opacity",
        isSuiteRunning ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
      )}>
      <Button
        type="button"
        variant="ghost"
        title="Edit suite"
        className="shrink-0 text-muted-foreground hover:text-foreground h-[22px] w-[22px] p-0"
        onClick={(e) => {
          e.stopPropagation();
          onEditSuite(suite.id);
        }}
      >
        <SquarePen className="h-3 w-3" />
      </Button>
      {canDelete ? (
        <Button
          type="button"
          variant="ghost"
          title="Delete suite"
          className="shrink-0 text-muted-foreground hover:text-foreground h-[22px] w-[22px] p-0"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteSuite(suite.id);
          }}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      ) : (
        <span className="shrink-0 p-1 text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
          <Trash2 className="h-3 w-3" />
        </span>
      )}
      {canChangeVisibility ? (
        <Button
          type="button"
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-foreground h-[22px] w-[22px] p-0"
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility(suite.id, isPublic ? "private" : "public");
          }}
          title={isPublic ? "Make private" : "Make public"}
        >
          {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
        </Button>
      ) : (
        <span className="shrink-0 p-0.5 text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
          {
            isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />
          }
        </span>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="h-[22px] w-[22px] p-0 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onRunSuite(suite.id);
        }}
        title={
          !suite.evaluatorAgentId
            ? "Evaluator Agent is required to run"
            : isSuiteRunning
              ? "A run is in progress"
              : "Run suite"
        }
        disabled={!suite.evaluatorAgentId || isSuiteRunning}
      >
        {isSuiteRunning ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Play className={cn("h-3 w-3", suite.evaluatorAgentId ? "fill-green-500 text-green-500" : "fill-muted-foreground text-muted-foreground")} />
        )}
      </Button>
      </div>
    );
}

export function EvalSuiteTree({
  suites,
  casesBySuite,
  selectedCaseId,
  liveRun,
  runningSuiteId,
  verdictByCaseId,
  onSelectCase,
  onRunSuite,
  onEditSuite,
  onDeleteSuite,
  onDeleteCase,
  onCreateCase,
  onEditCase,
  onToggleVisibility,
}: EvalSuiteTreeProps): ReactNode {
  const session = authClient.useSession();
  const { isAdmin } = useRole();
  const currentUserId = session.data?.user.id ?? null;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const evaluators = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of builtinAgents) {
      if (a.role === "evaluator") map[a.id] = a.name;
    }
    return map;
  }, [builtinAgents]);

  function toggleCollapse(suiteId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(suiteId)) next.delete(suiteId);
      else next.add(suiteId);
      return next;
    });
  }

  const totalCases = useMemo(() => {
    return Object.values(casesBySuite).reduce((sum, cases) => sum + cases.length, 0);
  }, [casesBySuite]);

  const sortedSuites = useMemo(() => {
    return [...suites].sort((a, b) => alphabeticCompare(a.name, b.name));
  }, [suites]);

  return (
    <div className="flex h-full flex-col border-r">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Test suite
        </h2>
        {totalCases > 0 && (
          <span className="text-[10px] text-muted-foreground">
            ({totalCases})
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            title="New case"
            className="h-6 w-6 p-0"
            onClick={() => onCreateCase("")}
          >
            <SquarePlus className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {sortedSuites.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            No evaluation suites yet.
          </div>
        ) : (
        sortedSuites.map((suite) => {
          const isCollapsed = collapsed.has(suite.id);
          const cases = casesBySuite[suite.id] ?? [];
          const sortedCases = [...cases].sort((a, b) => alphabeticCompare(a.name, b.name));
          const isSuiteRunning = liveRun.phase === "running" && runningSuiteId === suite.id;
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
                    {suite.evaluatorAgentId ? `${evaluators[suite.evaluatorAgentId] ?? "Unknown Evaluator"} · ` : ""}
                    {suite.dimensionIds.length} dim
                  </span>
                </div>
                {/* Live run status badge */}
                {runningSuiteId === suite.id && liveRun.phase !== "idle" && liveRun.totals && (
                  <span className="shrink-0 text-[9px] font-mono tabular-nums text-muted-foreground">
                    {liveRun.totals.passedCount}/{liveRun.totals.totalCount}
                  </span>
                )}
                <SuiteActions 
                  suite={suite} 
                  onEditSuite={onEditSuite}
                  onDeleteSuite={onDeleteSuite}
                  onToggleVisibility={onToggleVisibility}
                  onRunSuite={onRunSuite}
                  isSuiteRunning={isSuiteRunning}
                />
              </div>

              {/* Case list */}
              {!isCollapsed && (
                <div>
                  {sortedCases.map((c) => {
                    const verdict = verdictByCaseId.get(c.id);
                    const isSuiteOwner = suite.createdBy === currentUserId;
                    const isCaseOwner = c.createdBy === currentUserId;
                    const canDeleteCase = isAdmin || isSuiteOwner || isCaseOwner;

                    return (
                      <div
                        key={c.id}
                        className={cn(
                          "group/case flex w-full items-center gap-2 pl-7 pr-3 py-1.5 transition-colors",
                          selectedCaseId === c.id
                            ? "bg-accent"
                            : "hover:bg-muted/30",
                        )}
                      >
                        <div className="shrink-0 flex items-center justify-center">
                          <VerdictBadge verdict={verdict} />
                        </div>
                        <div className="min-w-0 flex-1 flex items-center">
                          <button
                            type="button"
                            onClick={() => onSelectCase(c.id)}
                            className="max-w-full truncate text-left text-xs cursor-pointer hover:underline"
                          >
                            {c.name}
                          </button>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/case:opacity-100 group-focus-within/case:opacity-100 focus-within:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={() => onEditCase(c)}
                            className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                            title="Edit case"
                          >
                            <SquarePen className="h-3 w-3" />
                          </button>
                          {canDeleteCase ? (
                            <button
                              type="button"
                              onClick={() => onDeleteCase(c.id, suite.id)}
                              className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-destructive"
                              title="Delete case"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          ) : (
                            <span className="shrink-0 p-0.5 text-muted-foreground/70 opacity-0 group-hover/case:opacity-100 transition-opacity">
                              <Trash2 className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
      </ScrollArea>
    </div>
  );
}
