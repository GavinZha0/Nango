"use client";

/**
 * CaseTree — left column of the verification suite editor.
 *
 * Two-level grouping for MCP suites: `mcpServerId` → `toolName` →
 * case rows. Each case row carries a small status badge driven by
 * (in priority order):
 *
 *   1. live-run verdict from `useVerificationRunStream(runId).caseResults`
 *      when a run is in flight or just finished;
 *   2. history-run verdict from `resultsByCaseId` when the user is
 *      inspecting a past run via the recent-runs banner;
 *   3. nothing — case has never been run in the visible run window.
 *
 * Server names are denormalised from the MCP server catalog at render
 * time (passed in via `serverNameById`). Tools have no display name —
 * we show `toolName` verbatim.
 *
 * Empty branches (server with no cases, tool with no cases) never
 * render — the tree is built from the case list, not from the
 * catalog.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { VerificationCaseResultStatus } from "@/lib/verification/types";
import type { VerificationCaseRow } from "@/store/verification-cases";

// --- Verdict surface --------------------------------------------------------

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

// --- Tree shape -------------------------------------------------------------

interface ToolGroup {
  toolName: string;
  cases: VerificationCaseRow[];
}
interface ServerGroup {
  serverId: string;
  serverName: string;
  tools: ToolGroup[];
}

function buildTree(
  cases: VerificationCaseRow[],
  serverNameById: ReadonlyMap<string, string>,
): ServerGroup[] {
  // Skip workflow / partially-populated rows — this view is MCP-only.
  const mcpCases = cases.filter(
    (c) => c.mcpServerId !== null && c.toolName !== null,
  );

  const byServer = new Map<string, Map<string, VerificationCaseRow[]>>();
  for (const c of mcpCases) {
    const serverId = c.mcpServerId!;
    const toolName = c.toolName!;
    let toolMap = byServer.get(serverId);
    if (!toolMap) {
      toolMap = new Map();
      byServer.set(serverId, toolMap);
    }
    const bucket = toolMap.get(toolName) ?? [];
    bucket.push(c);
    toolMap.set(toolName, bucket);
  }

  const out: ServerGroup[] = [];
  for (const [serverId, toolMap] of byServer.entries()) {
    const tools: ToolGroup[] = Array.from(toolMap.entries()).map(
      ([toolName, cs]) => ({
        toolName,
        cases: cs.slice().sort((a, b) => a.name.localeCompare(b.name)),
      }),
    );
    tools.sort((a, b) => a.toolName.localeCompare(b.toolName));
    out.push({
      serverId,
      serverName: serverNameById.get(serverId) ?? "(unknown server)",
      tools,
    });
  }
  out.sort((a, b) => a.serverName.localeCompare(b.serverName));
  return out;
}

// --- Component --------------------------------------------------------------

export interface CaseTreeProps {
  cases: VerificationCaseRow[];
  serverNameById: ReadonlyMap<string, string>;
  /** Per-case verdict — keyed by `verification_case.id`. */
  verdictByCaseId: ReadonlyMap<number, CaseVerdict>;
  selectedCaseId: number | null;
  onSelectCase: (caseId: number) => void;
  onNewCase: () => void;
  /** Open the rename dialog for this case. Omitted when `readOnly`. */
  onRequestEditCase?: (caseRow: VerificationCaseRow) => void;
  /** Open the delete-confirmation dialog for this case. Omitted when `readOnly`. */
  onRequestDeleteCase?: (caseRow: VerificationCaseRow) => void;
  loading: boolean;
  error: string | null;
  /** Extra elements rendered at the right end of the header, BEFORE
   *  the `+ New case` icon button. Today: the suite-level Run button.
   *  Kept as a slot so this component stays unaware of run state. */
  headerExtra?: ReactNode;
  /** When in history-view mode, hide the `+ New case` affordance and
   *  per-row edit/delete controls. */
  readOnly?: boolean;
}

export function CaseTree({
  cases,
  serverNameById,
  verdictByCaseId,
  selectedCaseId,
  onSelectCase,
  onNewCase,
  onRequestEditCase,
  onRequestDeleteCase,
  headerExtra,
  loading,
  error,
  readOnly = false,
}: CaseTreeProps): ReactNode {
  const groups = useMemo(
    () => buildTree(cases, serverNameById),
    [cases, serverNameById],
  );

  return (
    <div className="flex h-full flex-col border-r">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cases
        </h2>
        {cases.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            ({cases.length})
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onNewCase}
              title="Add case"
              aria-label="New case"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {headerExtra}
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
              <ServerGroupNode
                key={g.serverId}
                group={g}
                verdictByCaseId={verdictByCaseId}
                selectedCaseId={selectedCaseId}
                onSelectCase={onSelectCase}
                onRequestEditCase={readOnly ? undefined : onRequestEditCase}
                onRequestDeleteCase={readOnly ? undefined : onRequestDeleteCase}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// --- Nodes ------------------------------------------------------------------

interface ServerGroupNodeProps {
  group: ServerGroup;
  verdictByCaseId: ReadonlyMap<number, CaseVerdict>;
  selectedCaseId: number | null;
  onSelectCase: (caseId: number) => void;
  onRequestEditCase?: (caseRow: VerificationCaseRow) => void;
  onRequestDeleteCase?: (caseRow: VerificationCaseRow) => void;
}

function ServerGroupNode({
  group,
  verdictByCaseId,
  selectedCaseId,
  onSelectCase,
  onRequestEditCase,
  onRequestDeleteCase,
}: ServerGroupNodeProps): ReactNode {
  const [expanded, setExpanded] = useState<boolean>(true);
  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-left text-xs font-medium hover:bg-muted/30"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate">{group.serverName}</span>
      </button>
      {expanded &&
        group.tools.map((t) => (
          <ToolGroupNode
            key={t.toolName}
            tool={t}
            verdictByCaseId={verdictByCaseId}
            selectedCaseId={selectedCaseId}
            onSelectCase={onSelectCase}
            onRequestEditCase={onRequestEditCase}
            onRequestDeleteCase={onRequestDeleteCase}
          />
        ))}
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
}

function ToolGroupNode({
  tool,
  verdictByCaseId,
  selectedCaseId,
  onSelectCase,
  onRequestEditCase,
  onRequestDeleteCase,
}: ToolGroupNodeProps): ReactNode {
  const [expanded, setExpanded] = useState<boolean>(true);
  return (
    <div className="pl-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted/30"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="min-w-0 truncate font-mono">{tool.toolName}</span>
      </button>
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

// Case row — split into a clickable name button plus right-aligned
// edit / delete icon buttons. We deliberately avoid making the whole
// row a single button: with action icons present, a row-wide hit area
// is ambiguous (does clicking the gap select or do nothing?). The name
// is the obvious affordance for "open this case".

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
        "group/case-row flex items-center gap-1.5 rounded pl-7 pr-1 py-0.5 text-[11px]",
        selected ? "bg-accent text-foreground" : "hover:bg-muted/30",
        !caseRow.enabled && "opacity-50",
      )}
    >
      <VerdictBadge verdict={verdict} />
      {/* Wrap the name in a flex-1 container so the button itself is
          content-sized; clicking the empty space between the name and
          the action icons no longer selects the case (matches
          AgentPanel / VerificationPanel row convention). */}
      <div className="flex min-w-0 flex-1 items-center">
        <button
          type="button"
          onClick={onSelect}
          className="cursor-pointer truncate text-left hover:underline underline-offset-2"
        >
          {caseRow.name}
        </button>
      </div>
      {/* Rename / delete icons — hidden by default, revealed on row
          hover or when a child receives focus (keyboard accessibility).
          Keeps the list visually quiet during scan-by while remaining
          reachable. */}
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
          <Pencil className="h-3 w-3" />
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
