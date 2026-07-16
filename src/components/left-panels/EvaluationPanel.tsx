"use client";

/**
 * EvaluationPanel — left-sidebar panel for the evaluation feature.
 *
 * Lists agents that have evaluation suites, grouped by Builtin / External.
 * Wired to the evaluation Zustand store + API.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Loader2, Play, Trash2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/store/workspace";
import {
  useEvaluationStore,
  evalActions,
  agentKey,
  type EvalAgentItem,
} from "@/store/evaluation";

// Tab type

type EvalPanelTab = "builtin" | "external";

// Sub-components

interface TabButtonProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, count, active, onClick }: TabButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={active}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] leading-none",
          active
            ? "bg-primary/20 text-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

interface AgentRowProps {
  item: EvalAgentItem;
  active: boolean;
  onSelect: () => void;
  onRunAgent: () => void;
  onDeleteAgent: () => void;
}

function AgentRow({ item, active, onSelect, onRunAgent, onDeleteAgent }: AgentRowProps): ReactNode {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {item.agentIcon && (
          <span className="shrink-0 text-sm">{item.agentIcon}</span>
        )}
        <button
          type="button"
          onClick={onSelect}
          className="cursor-pointer truncate text-left text-sm font-medium hover:underline underline-offset-2"
          aria-label={`Open ${item.agentName ?? item.agentId}`}
        >
          {item.agentName ?? item.agentId}
        </button>
        {item.suiteCount > 0 && (
          <span
            className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
            title={`${item.suiteCount} suite${item.suiteCount === 1 ? "" : "s"}`}
          >
            {item.suiteCount}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 ml-2">
        {/* Run */}
        <button
          type="button"
          onClick={onRunAgent}
          title="Run all suites (except Drafts)"
          className="shrink-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-green-500"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
        </button>

        {/* 3. Delete */}
        <button
          type="button"
          onClick={onDeleteAgent}
          title="Delete all suites"
          className="shrink-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// Main component

export function EvaluationPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<EvalPanelTab>("builtin");

  const agents = useEvaluationStore((s) => s.agents);
  const agentsLoaded = useEvaluationStore((s) => s.agentsLoaded);
  const loading = useEvaluationStore((s) => s.loading);
  const suitesByAgent = useEvaluationStore((s) => s.suitesByAgent);

  const [deleteTarget, setDeleteTarget] = useState<EvalAgentItem | null>(null);

  const handleRunAgent = async (agentId: string, agentSource: string, credentialId: string | null) => {
    try {
      await fetch(`/api/eval-agents/${agentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentSource,
          credentialId,
        }),
      });
    } catch (err) {
      console.error("EvaluationPanel: failed to trigger run-all suites", err);
    }
  };

  // Resolve agent display names from workspace store (populated at app boot).
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const agentNames = useMemo(() => {
    const map: Record<string, { name: string; icon: string | null }> = {};
    for (const a of builtinAgents) map[a.id] = { name: a.name, icon: a.icon ?? null };
    return map;
  }, [builtinAgents]);

  useEffect(() => {
    if (!agentsLoaded) void evalActions.refreshAgents();
  }, [agentsLoaded]);

  const enriched: EvalAgentItem[] = agents.map((a) => {
    const resolved = agentNames[a.agentId];
    return {
      ...a,
      agentName: resolved?.name ?? a.agentName ?? a.agentId,
      agentIcon: resolved?.icon ?? a.agentIcon,
    };
  });

  const filtered = enriched.filter((a) =>
    activeTab === "builtin" ? a.agentSource === "builtin" : a.agentSource === "backend",
  );
  const builtinCount = enriched.filter((a) => a.agentSource === "builtin").length;
  const externalCount = enriched.filter((a) => a.agentSource === "backend").length;

  // Active row detection. Two route shapes flow into this panel:
  //   /evaluation/<id>                           → builtin
  //   /evaluation/<credentialId>/<agentId>        → backend
  const segments = pathname.startsWith("/evaluation/")
    ? pathname.replace("/evaluation/", "").split("/").filter(Boolean)
    : [];
  const activeBuiltinId = segments.length === 1 ? segments[0] : null;
  const activeBackend =
    segments.length === 2
      ? { credentialId: decodeURIComponent(segments[0]), agentId: decodeURIComponent(segments[1]) }
      : null;

  function isRowActive(item: EvalAgentItem): boolean {
    if (item.agentSource === "builtin") return item.agentId === activeBuiltinId;
    return activeBackend !== null
      && activeBackend.credentialId === item.credentialId
      && activeBackend.agentId === item.agentId;
  }

  function evalHref(item: EvalAgentItem): string {
    if (item.agentSource === "builtin") return `/evaluation/${item.agentId}`;
    return `/evaluation/${encodeURIComponent(item.credentialId ?? "")}/${encodeURIComponent(item.agentId)}`;
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const key = agentKey(deleteTarget.agentId, deleteTarget.agentSource);

    let suites = suitesByAgent[key];
    if (!suites || suites.length ===0) {
      await evalActions.refreshSuites(deleteTarget.agentId, deleteTarget.agentSource);
      suites = useEvaluationStore.getState().suitesByAgent[key] || [];
    }
    await Promise.all(suites.map((s) => evalActions.remove(s.id)));
    if (isRowActive(deleteTarget)) {
      router.push("/evaluation");
    }
    setDeleteTarget(null);
    void evalActions.refreshAgents();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch border-b bg-muted/40">
        <TabButton
          label="Builtin"
          count={builtinCount}
          active={activeTab === "builtin"}
          onClick={() => setActiveTab("builtin")}
        />
        <TabButton
          label="External"
          count={externalCount}
          active={activeTab === "external"}
          onClick={() => setActiveTab("external")}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading && !agentsLoaded ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">
            {activeTab === "builtin"
              ? "No built-in agent evaluations yet."
              : "No external agent evaluations yet."}
          </div>
        ) : (
          filtered.map((item) => (
            <AgentRow
              key={`${item.agentId}:${item.agentSource}`}
              item={item}
              active={isRowActive(item)}
              onSelect={() => router.push(evalHref(item))}
              onRunAgent={() => handleRunAgent(item.agentId, item.agentSource, item.credentialId)}
              onDeleteAgent={() => setDeleteTarget(item)}
            />
          ))
        )}
      </ScrollArea>

      <DeleteConfirmDialog
        title="Delete agent evaluations"
        description={
          deleteTarget ? (
            <>
              Permanently delete all suites for <strong>{deleteTarget.agentName ?? deleteTarget.agentId}</strong>? This cannot be undone.
            </>
          ) : (
            ""
          )
        }
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={handleDeleteConfirm}
        deleting={false}
      />
    </div>
  );
}
