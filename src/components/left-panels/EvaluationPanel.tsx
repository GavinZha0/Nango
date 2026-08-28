"use client";

/**
 * EvaluationPanel — left-sidebar panel for the evaluation feature.
 *
 * Renders a 2-level collapsible navigation tree:
 * Level 1: Agent (Builtin / Backend)
 * Level 2: Evaluation Suite
 */

import { useState, useMemo, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Loader2,
  Play,
  Trash2,
  ChevronDown,
  ChevronRight,
  SquarePen,
  Globe,
  Lock,
  Bot,
  RefreshCw,
  SquarePlus,
} from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { cn } from "@/lib/utils";
import { alphabeticCompare } from "@/lib/utils/sort";
import { useWorkspaceStore } from "@/store/workspace";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import {
  evalActions,
  type EvalAgentItem,
  type EvalSuiteRow,
} from "@/store/evaluation";
import { EvalSuiteEditDialog } from "@/components/main-panels/evaluation/EvalSuiteEditDialog";
import { NewEvalSuiteDialog } from "@/components/main-panels/evaluation/NewEvalSuiteDialog";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch data");
  return res.json();
};

type EvalPanelTab = "builtin" | "external";

interface EvalAgentTreeGroup {
  agentId: string;
  agentSource: string;
  agentName: string;
  agentIcon: string | null;
  credentialId?: string | null;
  suites: EvalSuiteRow[];
}

interface SuiteRowItemProps {
  suite: EvalSuiteRow;
  active: boolean;
  onSelect: () => void;
  onRunSuite: (e: React.MouseEvent) => void;
  onToggleVisibility: (e: React.MouseEvent) => void;
  onEditSuite: (e: React.MouseEvent) => void;
  onDeleteSuite: (e: React.MouseEvent) => void;
  running: boolean;
}

function SuiteRowItem({
  suite,
  active,
  onSelect,
  onRunSuite,
  onToggleVisibility,
  onEditSuite,
  onDeleteSuite,
  running,
}: SuiteRowItemProps): ReactNode {
  const isPublic = suite.visibility === "public";
  const { canChangeVisibility, canDelete } = useResourcePermissions({
    source: "local" as const,
    visibility: suite.visibility,
    createdBy: suite.createdBy,
  });

  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center justify-between pl-7 pr-2 py-1.5 text-xs transition-colors rounded select-none",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        !suite.enabled && "opacity-50",
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-1.5 min-w-0 pr-1">
        <span className="truncate">{suite.name}</span>
        {suite.caseCount > 0 && (
          <span
            className="shrink-0 rounded-full bg-muted px-1.5 py-0.2 text-[9px] font-mono text-muted-foreground"
            title={`${suite.caseCount} case${suite.caseCount === 1 ? "" : "s"}`}
          >
            {suite.caseCount}
          </span>
        )}
      </div>

      {/* Action group on hover */}
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onRunSuite}
          disabled={running || !suite.enabled}
          title="Run"
          className="rounded p-0.5 text-muted-foreground/70 hover:text-emerald-500 transition-colors disabled:opacity-40"
        >
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3 fill-current" />
          )}
        </button>

        {canChangeVisibility && (
          <button
            type="button"
            onClick={onToggleVisibility}
            title={isPublic ? "Make private" : "Make public"}
            className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
          </button>
        )}

        <button
          type="button"
          onClick={onEditSuite}
          title="Edit"
          className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors"
        >
          <SquarePen className="h-3 w-3" />
        </button>

        {canDelete && (
          <button
            type="button"
            onClick={onDeleteSuite}
            title="Delete"
            className="rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface AgentGroupNodeProps {
  group: EvalAgentTreeGroup;
  expanded: boolean;
  onToggleExpand: () => void;
  activeSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onRunAgent: (e: React.MouseEvent) => void;
  onRunSuite: (suiteId: string, e: React.MouseEvent) => void;
  onToggleSuiteVisibility: (suite: EvalSuiteRow, e: React.MouseEvent) => void;
  onEditSuite: (suite: EvalSuiteRow, e: React.MouseEvent) => void;
  onDeleteSuite: (suite: EvalSuiteRow, e: React.MouseEvent) => void;
  onDeleteAgent: (e: React.MouseEvent) => void;
  runningAgentKey: string | null;
  runningSuiteId: string | null;
}

function AgentGroupNode({
  group,
  expanded,
  onToggleExpand,
  activeSuiteId,
  onSelectSuite,
  onRunAgent,
  onRunSuite,
  onToggleSuiteVisibility,
  onEditSuite,
  onDeleteSuite,
  onDeleteAgent,
  runningAgentKey,
  runningSuiteId,
}: AgentGroupNodeProps): ReactNode {
  const currentKey = `${group.agentId}:${group.agentSource}`;
  const isAgentRunning = runningAgentKey === currentKey;

  return (
    <div className="select-none border-b border-border/40 last:border-0">
      {/* Level 1: Agent Node */}
      <div
        className="group flex items-center justify-between px-2.5 py-1.5 transition-colors hover:bg-muted/30 text-xs cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          {group.agentIcon ? (
            <span className="shrink-0 text-xs">{group.agentIcon}</span>
          ) : (
            <Bot className="h-3.5 w-3.5 text-indigo-500/70 shrink-0" />
          )}
          <span className="truncate font-medium hover:underline underline-offset-2">
            {group.agentName}
          </span>
          {group.suites.length > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.2 text-[9px] text-muted-foreground">
              {group.suites.length}
            </span>
          )}
        </div>

        {/* Level 1 Actions */}
        <div className="flex shrink-0 items-center gap-1 ml-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={onRunAgent}
            disabled={isAgentRunning}
            title="Run all evaluation suites for this agent"
            className="rounded p-0.5 text-muted-foreground/70 hover:text-emerald-500 transition-colors disabled:opacity-40"
          >
            {isAgentRunning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
          </button>

          <button
            type="button"
            onClick={onDeleteAgent}
            title="Delete"
            className="rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Level 2: Suites List */}
      {expanded && (
        <div className="flex flex-col py-0.5">
          {group.suites.length === 0 ? (
            <div className="pl-8 py-1 text-[11px] text-muted-foreground italic">
              No suites created yet.
            </div>
          ) : (
            group.suites.map((suite) => (
              <SuiteRowItem
                key={suite.id}
                suite={suite}
                active={activeSuiteId === suite.id}
                onSelect={() => onSelectSuite(suite.id)}
                onRunSuite={(e) => onRunSuite(suite.id, e)}
                onToggleVisibility={(e) => onToggleSuiteVisibility(suite, e)}
                onEditSuite={(e) => onEditSuite(suite, e)}
                onDeleteSuite={(e) => onDeleteSuite(suite, e)}
                running={runningSuiteId === suite.id}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function EvaluationPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<EvalPanelTab>("builtin");

  // Derive active suite ID from /evaluation/[id]
  const activeSuiteMatch = pathname.match(/^\/evaluation\/([^/]+)/);
  const activeSuiteId = activeSuiteMatch ? activeSuiteMatch[1] : null;

  // 1. Fetch agents summary
  const { data: agentRows, error: agentError, isLoading: agentLoading, mutate: mutateAgents } = useSWR<EvalAgentItem[]>(
    "/api/eval-suites/agents",
    fetcher,
  );

  // 2. Fetch all suites
  const { data: suiteRows, error: suiteError, isLoading: suiteLoading, mutate: mutateSuites } = useSWR<EvalSuiteRow[]>(
    "/api/eval-suites",
    fetcher,
  );

  // Resolve agent names from workspace store
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const agentMap = useMemo(() => {
    const map: Record<string, { name: string; icon: string | null }> = {};
    for (const a of builtinAgents) map[a.id] = { name: a.name, icon: a.icon ?? null };
    return map;
  }, [builtinAgents]);

  const [expandedAgentKeys, setExpandedAgentKeys] = useState<Record<string, boolean>>({});

  const toggleAgentExpand = (key: string): void => {
    setExpandedAgentKeys((prev) => ({
      ...prev,
      [key]: prev[key] !== undefined ? !prev[key] : false, // default was true
    }));
  };

  // Build tree grouping
  const treeGroups = useMemo<EvalAgentTreeGroup[]>(() => {
    if (!agentRows) return [];

    const suitesByAgent = new Map<string, EvalSuiteRow[]>();
    for (const suite of suiteRows ?? []) {
      const key = `${suite.agentId}:${suite.agentSource}`;
      const list = suitesByAgent.get(key) ?? [];
      list.push(suite);
      suitesByAgent.set(key, list);
    }

    const filtered = agentRows.filter((a) =>
      activeTab === "builtin" ? a.agentSource === "builtin" : a.agentSource === "backend",
    );

    return filtered.map((a) => {
      const resolved = agentMap[a.agentId];
      const key = `${a.agentId}:${a.agentSource}`;
      return {
        agentId: a.agentId,
        agentSource: a.agentSource,
        agentName: resolved?.name ?? a.agentName ?? a.agentId,
        agentIcon: resolved?.icon ?? a.agentIcon ?? null,
        credentialId: a.credentialId,
        suites: (suitesByAgent.get(key) ?? []).sort((s1, s2) =>
          alphabeticCompare(s1.name, s2.name),
        ),
      };
    }).sort((a, b) =>
      alphabeticCompare(a.agentName || a.agentId, b.agentName || b.agentId),
    );
  }, [agentRows, suiteRows, activeTab, agentMap]);

  const builtinCount = useMemo(
    () => (agentRows ?? []).filter((a) => a.agentSource === "builtin").length,
    [agentRows],
  );
  const externalCount = useMemo(
    () => (agentRows ?? []).filter((a) => a.agentSource === "backend").length,
    [agentRows],
  );

  const [runningAgentKey, setRunningAgentKey] = useState<string | null>(null);
  const [runningSuiteId, setRunningSuiteId] = useState<string | null>(null);

  const [createSuiteOpen, setCreateSuiteOpen] = useState<boolean>(false);
  const [editingSuite, setEditingSuite] = useState<EvalSuiteRow | null>(null);
  const [deletingSuite, setDeletingSuite] = useState<EvalSuiteRow | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<EvalAgentTreeGroup | null>(null);

  const handleRunAgent = async (group: EvalAgentTreeGroup, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const key = `${group.agentId}:${group.agentSource}`;
    setRunningAgentKey(key);
    try {
      const res = await fetch(`/api/eval-agents/${group.agentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentSource: group.agentSource,
          credentialId: group.credentialId,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Triggered agent evaluation run");
    } catch {
      toast.error("Failed to trigger agent evaluation");
    } finally {
      setRunningAgentKey(null);
    }
  };

  const handleRunSuite = async (suiteId: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    setRunningSuiteId(suiteId);
    try {
      const res = await fetch(`/api/eval-suites/${suiteId}/run`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Triggered suite evaluation run");
    } catch {
      toast.error("Failed to trigger suite evaluation");
    } finally {
      setRunningSuiteId(null);
    }
  };

  const handleToggleSuiteVisibility = async (suite: EvalSuiteRow, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const next = suite.visibility === "public" ? "private" : "public";
    try {
      const res = await fetch(`/api/eval-suites/${suite.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (res.ok) {
        void mutateSuites();
        toast.success(`Suite visibility set to ${next}`);
      }
    } catch {
      toast.error("Failed to update suite visibility");
    }
  };

  const handleSuiteSave = async (updated: { name: string; evaluatorAgentId?: string | null; dimensionIds: string[] }): Promise<void> => {
    if (!editingSuite) return;
    try {
      await evalActions.patch(editingSuite.id, updated);
      void mutateSuites();
      toast.success("Suite updated");
      setEditingSuite(null);
    } catch {
      toast.error("Failed to update suite");
    }
  };

  const handleSuiteDeleteConfirm = async (): Promise<void> => {
    if (!deletingSuite) return;
    try {
      await evalActions.remove(deletingSuite.id);
      void mutateSuites();
      toast.success("Suite deleted");
      if (activeSuiteId === deletingSuite.id) {
        router.push("/evaluation");
      }
    } catch {
      toast.error("Failed to delete suite");
    } finally {
      setDeletingSuite(null);
    }
  };

  const handleDeleteAgentConfirm = async (): Promise<void> => {
    if (!deletingAgent) return;
    try {
      await Promise.all(deletingAgent.suites.map((s) => evalActions.remove(s.id)));
      void mutateAgents();
      void mutateSuites();
      toast.success("Deleted all suites for agent");
      router.push("/evaluation");
    } catch {
      toast.error("Failed to delete agent evaluation suites");
    } finally {
      setDeletingAgent(null);
    }
  };

  const isTreeLoading = agentLoading || suiteLoading;
  const treeError = agentError || suiteError;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tabs Toolbar */}
      <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
        <button
          type="button"
          onClick={() => setActiveTab("builtin")}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
            activeTab === "builtin"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={activeTab === "builtin"}
        >
          Builtin
          <span
            className={cn(
              "rounded-full px-1.5 py-0.2 text-[9px] font-mono",
              activeTab === "builtin"
                ? "bg-primary/20 text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {builtinCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("external")}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
            activeTab === "external"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={activeTab === "external"}
        >
          External
          <span
            className={cn(
              "rounded-full px-1.5 py-0.2 text-[9px] font-mono",
              activeTab === "external"
                ? "bg-primary/20 text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {externalCount}
          </span>
        </button>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={() => setCreateSuiteOpen(true)}
            aria-label="New suite"
            title="New suite"
          >
            <SquarePlus className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground"
            onClick={() => {
              void mutateAgents();
              void mutateSuites();
            }}
            disabled={isTreeLoading}
            aria-label="Refresh list"
            title="Refresh list"
          >
            <RefreshCw
              className={cn("h-3 w-3", isTreeLoading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {/* Main Tree List */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          {treeError && (
            <p className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {treeError.message || "Failed to load evaluation targets."}
            </p>
          )}

          {isTreeLoading && treeGroups.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground flex justify-center items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading agents…
            </div>
          ) : treeGroups.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {activeTab === "builtin"
                ? "No built-in agent evaluations found."
                : "No external agent evaluations found."}
            </div>
          ) : (
            treeGroups.map((group) => {
              const key = `${group.agentId}:${group.agentSource}`;
              return (
                <AgentGroupNode
                  key={key}
                  group={group}
                  expanded={expandedAgentKeys[key] ?? true}
                  onToggleExpand={() => toggleAgentExpand(key)}
                  activeSuiteId={activeSuiteId}
                  onSelectSuite={(suiteId) => router.push(`/evaluation/${suiteId}`)}
                  onRunAgent={(e) => void handleRunAgent(group, e)}
                  onRunSuite={handleRunSuite}
                  onToggleSuiteVisibility={handleToggleSuiteVisibility}
                  onEditSuite={setEditingSuite}
                  onDeleteSuite={setDeletingSuite}
                  onDeleteAgent={() => setDeletingAgent(group)}
                  runningAgentKey={runningAgentKey}
                  runningSuiteId={runningSuiteId}
                />
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* New Suite Dialog */}
      <NewEvalSuiteDialog
        open={createSuiteOpen}
        onOpenChange={setCreateSuiteOpen}
        defaultAgentSource={activeTab === "builtin" ? "builtin" : "backend"}
        onCreated={(created) => {
          void mutateSuites();
          void mutateAgents();
          router.push(`/evaluation/${created.id}`);
        }}
      />

      {/* Suite Edit Dialog */}
      {editingSuite && (
        <EvalSuiteEditDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingSuite(null);
          }}
          suite={editingSuite}
          onSave={handleSuiteSave}
        />
      )}

      {/* Delete Suite Confirmation */}
      <DeleteConfirmDialog
        title="Delete evaluation suite"
        description={
          deletingSuite ? (
            <>
              Permanently delete suite <strong>{deletingSuite.name}</strong> and all its test cases? This cannot be undone.
            </>
          ) : (
            ""
          )
        }
        open={deletingSuite !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingSuite(null);
        }}
        onConfirm={handleSuiteDeleteConfirm}
        deleting={false}
      />

      {/* Delete Agent Suites Confirmation */}
      <DeleteConfirmDialog
        title="Delete all agent evaluation suites"
        description={
          deletingAgent ? (
            <>
              Permanently delete all evaluation suites for <strong>{deletingAgent.agentName}</strong>? This cannot be undone.
            </>
          ) : (
            ""
          )
        }
        open={deletingAgent !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingAgent(null);
        }}
        onConfirm={handleDeleteAgentConfirm}
        deleting={false}
      />
    </div>
  );
}
