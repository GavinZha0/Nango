"use client";

/**
 * EvaluationPanel — left-sidebar panel for the evaluation feature.
 *
 * Lists agents that have evaluation suites, grouped by Builtin / External.
 * Wired to the evaluation Zustand store + API.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useEvaluationStore,
  evalActions,
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
}

function AgentRow({ item, active, onSelect }: AgentRowProps): ReactNode {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
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
        {item.caseCount > 0 && (
          <span
            className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
            title={`${item.caseCount} case${item.caseCount === 1 ? "" : "s"}`}
          >
            {item.caseCount}
          </span>
        )}
      </div>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {item.suiteCount} suite{item.suiteCount === 1 ? "" : "s"}
      </span>
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

  // Resolve agent display names — fetch from builtin_agent catalog
  const [agentNames, setAgentNames] = useState<Record<string, { name: string; icon: string | null }>>({});

  useEffect(() => {
    if (!agentsLoaded) void evalActions.refreshAgents();
  }, [agentsLoaded]);

  useEffect(() => {
    async function resolveNames(): Promise<void> {
      try {
        const res = await fetch("/api/builtin-agents");
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{ id: string; name: string; icon: string | null }>;
        const map: Record<string, { name: string; icon: string | null }> = {};
        for (const r of rows) map[r.id] = { name: r.name, icon: r.icon };
        setAgentNames(map);
      } catch { /* silent */ }
    }
    void resolveNames();
  }, []);

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

  const activeId = pathname.startsWith("/evaluation/")
    ? pathname.split("/")[2] ?? null
    : null;

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
              active={item.agentId === activeId}
              onSelect={() => router.push(`/evaluation/${item.agentId}`)}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
