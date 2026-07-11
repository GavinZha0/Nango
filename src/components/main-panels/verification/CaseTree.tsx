"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Globe,
  Lock,
  SquarePen,
  Play,
  Trash2,
  SquarePlus,
} from "lucide-react";

import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { VerificationCaseResultStatus } from "@/lib/verification/types";
import type { VerificationCaseRow } from "@/store/verification-cases";

export interface CaseVerdict {
  status: VerificationCaseResultStatus;
}

function VerdictBadge({ verdict }: { verdict: CaseVerdict | undefined }): ReactNode {
  if (!verdict) {
    return <CircleSlash className="h-3 w-3 text-muted-foreground/40" />;
  }
  switch (verdict.status) {
    case "passed":
      return <CircleCheck className="h-3 w-3 text-emerald-500" />;
    case "failed":
      return <CircleX className="h-3 w-3 text-red-500" />;
    case "errored":
      return <CircleAlert className="h-3 w-3 text-amber-500" />;
    case "timeout":
      return <Clock className="h-3 w-3 text-amber-500" />;
    case "skipped":
      return <CircleSlash className="h-3 w-3 text-muted-foreground" />;
  }
}

interface ToolGroup {
  toolName: string;
  suiteId: string;
  suiteVisibility: "public" | "private";
  suiteCreatedBy: string;
  cases: VerificationCaseRow[];
}

function buildTree(cases: VerificationCaseRow[]): ToolGroup[] {
  const byTool = new Map<string, VerificationCaseRow[]>();
  for (const c of cases) {
    if (!c.toolName) continue;
    const bucket = byTool.get(c.toolName) ?? [];
    bucket.push(c);
    byTool.set(c.toolName, bucket);
  }

  const out: ToolGroup[] = Array.from(byTool.entries()).map(([toolName, cs]) => ({
    toolName,
    suiteId: cs[0]?.suiteId ?? "",
    suiteVisibility: (cs[0]?.suiteVisibility ?? "private") as "public" | "private",
    suiteCreatedBy: cs[0]?.suiteCreatedBy ?? "",
    cases: cs.slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));
  out.sort((a, b) => a.toolName.localeCompare(b.toolName));
  return out;
}

export interface CaseTreeProps {
  cases: VerificationCaseRow[];
  serverNameById: ReadonlyMap<string, string>;
  verdictByCaseId: ReadonlyMap<number, CaseVerdict>;
  selectedCaseId: number | null;
  onSelectCase: (caseId: number) => void;
  onNewCase: () => void;
  onRequestEditCase?: (caseRow: VerificationCaseRow) => void;
  onRequestDeleteCase?: (caseRow: VerificationCaseRow) => void;
  onRunTool?: (suiteId: string) => void;
  onToggleSuiteVisibility?: (suiteId: string, visibility: "public" | "private") => void;
  loading: boolean;
  error: string | null;
  readOnly?: boolean;
}

export function CaseTree({
  cases,
  verdictByCaseId,
  selectedCaseId,
  onSelectCase,
  onNewCase,
  onRequestEditCase,
  onRequestDeleteCase,
  onRunTool,
  onToggleSuiteVisibility,
  loading,
  error,
  readOnly = false,
}: CaseTreeProps): ReactNode {
  const groups = useMemo(() => buildTree(cases), [cases]);

  return (
    <div className="flex h-full flex-col border-r">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Test suite
        </h2>
        {cases.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            ({cases.length})
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            title="New case"
            className="h-6 w-6 p-0"
            onClick={onNewCase}
          >
            <SquarePlus className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          {error && (
            <p className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}
          {loading && cases.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">Loading…</p>
          ) : groups.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              {readOnly ? (
                "This run has no recorded cases."
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
            groups.map((g) => (
              <ToolGroupNode
                key={g.toolName}
                tool={g}
                verdictByCaseId={verdictByCaseId}
                selectedCaseId={selectedCaseId}
                onSelectCase={onSelectCase}
                onRequestEditCase={readOnly ? undefined : onRequestEditCase}
                onRequestDeleteCase={readOnly ? undefined : onRequestDeleteCase}
                onRunTool={onRunTool}
                onToggleSuiteVisibility={onToggleSuiteVisibility}
                readOnly={readOnly}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface ToolGroupNodeProps {
  tool: ToolGroup;
  verdictByCaseId: ReadonlyMap<number, CaseVerdict>;
  selectedCaseId: number | null;
  onSelectCase: (caseId: number) => void;
  onRequestEditCase?: (caseRow: VerificationCaseRow) => void;
  onRequestDeleteCase?: (caseRow: VerificationCaseRow) => void;
  onRunTool?: (suiteId: string) => void;
  onToggleSuiteVisibility?: (suiteId: string, visibility: "public" | "private") => void;
  readOnly?: boolean;
}

function ToolGroupNode({
  tool,
  verdictByCaseId,
  selectedCaseId,
  onSelectCase,
  onRequestEditCase,
  onRequestDeleteCase,
  onRunTool,
  onToggleSuiteVisibility,
  readOnly = false,
}: ToolGroupNodeProps): ReactNode {
  const [expanded, setExpanded] = useState<boolean>(true);
  const isPublic = tool.suiteVisibility === "public";
  const { canChangeVisibility } = useResourcePermissions({
    source: "local" as const,
    visibility: tool.suiteVisibility,
    createdBy: tool.suiteCreatedBy,
  });

  return (
    <div className="px-1 py-0.5">
      <div className="group/tool-node flex items-center justify-between rounded px-1.5 py-0.5 hover:bg-muted/30">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 cursor-pointer items-center gap-1 text-left text-xs text-muted-foreground"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <span className="min-w-0 truncate font-mono">{tool.toolName}</span>
        </button>

        {!readOnly && canChangeVisibility && onToggleSuiteVisibility? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSuiteVisibility(tool.suiteId, isPublic ? "private" : "public");
            }}
            className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/70 opacity-0 group-hover/tool-node:opacity-100 transition-opacity hover:text-foreground"
            aria-label={isPublic ? "Make private" : "Make public"}
          >
            {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
          </button>
        ): (
          <span className="shrink-0 p-0.5 text-muted-foreground/70 opacity-0 group-hover/tool-node:opacity-100 transition-opacity" >
            {
              isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />
            }
          </span>
        )}

        {!readOnly && onRunTool && tool.suiteId && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRunTool(tool.suiteId);
            }}
            className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 group-hover/tool-node:opacity-100 transition-opacity hover:text-foreground"
            title="Run suite"
          >
            <Play className="h-3 w-3 fill-green-500 text-green-500" />
          </button>
        )}
      </div>
      {expanded &&
        tool.cases.map((c) => (
          <CaseRow
            key={c.id}
            caseRow={c}
            verdict={verdictByCaseId.get(c.id)}
            selected={selectedCaseId === c.id}
            onSelect={() => onSelectCase(c.id)}
            onRequestEdit={
              onRequestEditCase ? () => onRequestEditCase(c) : undefined
            }
            onRequestDelete={
              onRequestDeleteCase ? () => onRequestDeleteCase(c) : undefined
            }
          />
        ))}
    </div>
  );
}

interface CaseRowProps {
  caseRow: VerificationCaseRow;
  verdict: CaseVerdict | undefined;
  selected: boolean;
  onSelect: () => void;
  onRequestEdit?: () => void;
  onRequestDelete?: () => void;
}

function CaseRow({
  caseRow,
  verdict,
  selected,
  onSelect,
  onRequestEdit,
  onRequestDelete,
}: CaseRowProps): ReactNode {
  return (
    <div
      className={cn(
        "group/case-row flex items-center gap-1.5 rounded pl-7 pr-1 py-0.5 text-xs",
        selected ? "bg-accent text-foreground" : "hover:bg-muted/30",
        !caseRow.enabled && "opacity-50",
      )}
    >
      <VerdictBadge verdict={verdict} />
      <div className="flex min-w-0 flex-1 items-center">
        <button
          type="button"
          onClick={onSelect}
          className="cursor-pointer truncate text-left hover:underline underline-offset-2"
        >
          {caseRow.name}
        </button>
      </div>
      {onRequestEdit && (
        <button
          type="button"
          onClick={onRequestEdit}
          aria-label={`Edit ${caseRow.name}`}
          className={cn(
            "shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-opacity hover:text-foreground",
            "opacity-0 group-hover/case-row:opacity-100 group-focus-within/case-row:opacity-100 focus-visible:opacity-100",
          )}
        >
          <SquarePen className="h-3 w-3" />
        </button>
      )}
      {onRequestDelete && (
        <button
          type="button"
          onClick={onRequestDelete}
          aria-label={`Delete ${caseRow.name}`}
          className={cn(
            "shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-opacity hover:text-destructive",
            "opacity-0 group-hover/case-row:opacity-100 group-focus-within/case-row:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
