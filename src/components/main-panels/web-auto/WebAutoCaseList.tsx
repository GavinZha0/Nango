"use client";

import { type ReactNode } from "react";
import {
  Plus,
  Play,
  SquarePen,
  Trash2,
  Loader2,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CaseVerdictBadge, CaseEnableToggle, type UniversalVerdictStatus } from "@/components/main-panels/common";
import type { WebAutoCaseRow } from "@/store/web-auto-store";

export interface CaseVerdict {
  status: "passed" | "failed" | "errored" | "running" | null;
  durationMs?: number | null;
}

export interface WebAutoCaseListProps {
  cases: WebAutoCaseRow[];
  verdictByCaseId: ReadonlyMap<number, CaseVerdict>;
  selectedCaseId: number | null;
  onSelectCase: (caseId: number) => void;
  onNewCase: () => void;
  onRunSuite?: () => void;
  isSuiteRunning?: boolean;
  mcpServerId?: string | null;
  onToggleCaseEnabled?: (caseId: number, nextEnabled: boolean) => void;
  onRequestEditCase?: (caseRow: WebAutoCaseRow) => void;
  onRequestDeleteCase?: (caseRow: WebAutoCaseRow) => void;
  loading: boolean;
  error: string | null;
  readOnly?: boolean;
}

export function WebAutoCaseList({
  cases,
  verdictByCaseId,
  selectedCaseId,
  onSelectCase,
  onNewCase,
  onRunSuite,
  isSuiteRunning = false,
  mcpServerId,
  onToggleCaseEnabled,
  onRequestEditCase,
  onRequestDeleteCase,
  loading,
  error,
  readOnly = false,
}: WebAutoCaseListProps): ReactNode {
  return (
    <div className="flex h-full flex-col border-r border-border/60 bg-background overflow-hidden">
      {/* Header: Test suite (x) + compact [+] [▶] buttons */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/40 px-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
            Test suite
          </h2>
          {cases.length > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              ({cases.length})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="New case"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              onClick={onNewCase}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {onRunSuite && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={
                !mcpServerId
                  ? "Playwright not configured"
                  : "Run suite"
              }
              className="h-6 w-6 p-0 text-emerald-600 hover:text-emerald-500 hover:bg-emerald-500/10"
              disabled={!mcpServerId || cases.length === 0 || isSuiteRunning}
              onClick={onRunSuite}
            >
              {isSuiteRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Case List Scroll Area */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-1 px-1">
          {error && (
            <div className="mx-2 my-1.5 flex items-center gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && cases.length === 0 ? (
            <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading cases…
            </div>
          ) : cases.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              {readOnly ? (
                "This suite has no cases."
              ) : (
                <>
                  No cases yet.{" "}
                  <button
                    type="button"
                    className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                    onClick={onNewCase}
                  >
                    Add one
                  </button>
                  .
                </>
              )}
            </div>
          ) : (
            cases.map((c) => {
              const verdict = verdictByCaseId.get(c.id);
              const isSelected = selectedCaseId === c.id;

              return (
                <div
                  key={c.id}
                  className={cn(
                    "group relative flex items-center justify-between rounded px-2 py-1.5 text-xs transition-colors mb-0.5 select-none",
                    isSelected ? "bg-accent text-accent-foreground font-medium" : "hover:bg-muted/30 text-foreground",
                    !c.enabled && "opacity-50",
                  )}
                >
                  {/* Left: Verdict Status Badge + Clickable Case Name + Duration */}
                  <div className="flex items-center gap-1.5 min-w-0 flex-1 pr-1">
                    <CaseVerdictBadge status={verdict?.status as UniversalVerdictStatus} />
                    <button
                      type="button"
                      onClick={() => onSelectCase(c.id)}
                      className={cn(
                        "cursor-pointer truncate text-left hover:underline underline-offset-2 flex-1",
                        !c.enabled && "text-muted-foreground",
                      )}
                      title={c.name}
                    >
                      {c.name}
                    </button>
                    {verdict?.durationMs !== undefined && verdict.durationMs !== null && verdict.durationMs > 0 && (
                      <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                        {(verdict.durationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>

                  {/* Right Actions: Enable Toggle + Edit + Delete (hover visible) */}
                  {!readOnly && (
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      {onToggleCaseEnabled && (
                        <CaseEnableToggle
                          enabled={c.enabled}
                          onToggle={(next) => onToggleCaseEnabled(c.id, next)}
                        />
                      )}
                      {onRequestEditCase && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRequestEditCase(c);
                          }}
                          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors"
                          title="Edit"
                          aria-label={`Edit ${c.name}`}
                        >
                          <SquarePen className="h-3 w-3" />
                        </button>
                      )}
                      {onRequestDeleteCase && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRequestDeleteCase(c);
                          }}
                          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors"
                          title="Delete"
                          aria-label={`Delete ${c.name}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
