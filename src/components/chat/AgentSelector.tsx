"use client";

import { Fragment, useCallback, useState, useMemo } from "react";
import type { ReactNode } from "react";
import { Bot, ChevronDown, ChevronRight, Sparkles, Users } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentKey } from "@/lib/backends/facade";
import type { EntityKind } from "@/lib/backends/types";
import { cn } from "@/lib/utils";
import { alphabeticCompare } from "@/lib/utils/sort";
import type { BuiltinAgentRow } from "@/lib/types/builtin-agent";

/**
 * AgentSelector — compact dropdown that lists every visible backend
 * agent and built-in agent, grouped with collapsible sections.
 */

export interface AgentSelectorProps {
  activeAgentId: string;
  activeAgentType: EntityKind;
  /** Credential the active agent belongs to. Combined with activeAgentId
   *  it uniquely identifies a row, since two credentials may legitimately
   *  surface agents with the same id (e.g. multiple Dify credentials
   *  each producing an agent with synthetic id "default"). */
  activeCredentialId: string | undefined;
  agents: { id: string; name?: string; credentialId?: string; provider?: string; credentialName?: string }[];
  teams: { id: string; name?: string; credentialId?: string; provider?: string; credentialName?: string }[];
  builtinAgents: BuiltinAgentRow[];
  disabledBackend: Set<string>;
  onSelect: (
    id: string,
    type: EntityKind,
    source?: "backend" | "builtin",
    credentialId?: string,
    provider?: string,
  ) => void;
}

/** Clickable group header with chevron + count badge. */
function GroupHeader({
  label,
  count,
  expanded,
  onToggle,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "flex w-full items-center gap-1 px-1.5 py-1 text-xs font-medium",
        "text-muted-foreground hover:text-foreground",
        "select-none outline-none",
      )}
    >
      <Chevron className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
      <span className="ml-auto text-[10px] tabular-nums opacity-60">
        {count}
      </span>
    </button>
  );
}

export function AgentSelector({
  activeAgentId,
  activeAgentType,
  activeCredentialId,
  agents,
  teams,
  builtinAgents,
  disabledBackend,
  onSelect,
}: AgentSelectorProps): ReactNode {
  const visibleAgents = agents.filter(
    (a) => !disabledBackend.has(agentKey(a.credentialId, a.id)),
  );
  const visibleTeams = teams.filter(
    (t) => !disabledBackend.has(agentKey(t.credentialId, t.id)),
  );
  // System-role agents are hidden from the picker but kept in lookup
  // for active-name resolution.
  const enabledBuiltin = useMemo(() => builtinAgents.filter((b) => b.enabled), [builtinAgents]);
  const visibleBuiltin = useMemo(() => enabledBuiltin.filter((b) => !b.role), [enabledBuiltin]);
  const sortedVisibleBuiltin = useMemo(() => {
    return [...visibleBuiltin].sort((a, b) => alphabeticCompare(a.name, b.name));
  }, [visibleBuiltin]);

  const backendEntries = [
    ...visibleAgents.map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      type: "agent" as const,
      source: "backend" as const,
      credentialId: a.credentialId,
      provider: a.provider,
      credentialName: a.credentialName ?? "Backend",
    })),
    ...visibleTeams.map((t) => ({
      id: t.id,
      name: t.name ?? t.id,
      type: "team" as const,
      source: "backend" as const,
      credentialId: t.credentialId,
      provider: t.provider,
      credentialName: t.credentialName ?? "Backend",
    })),
  ];

  const backendGroups = new Map<string, typeof backendEntries>();
  for (const e of backendEntries) {
    const list = backendGroups.get(e.credentialName);
    if (list) list.push(e);
    else backendGroups.set(e.credentialName, [e]);
  }

  const allEntries = [
    ...backendEntries,
    // System-role agents kept here so the active-agent header still
    // renders them by name even though the picker hides them.
    ...enabledBuiltin.map((b) => ({
      id: b.id,
      name: b.name,
      type: "agent" as const,
      source: "builtin" as const,
      credentialName: b.role === "supervisor" ? "Nango" : "BuiltIn",
      isSupervisor: b.role === "supervisor",
    })),
  ];

  // Match by credentialId and id. Built-in agents match when activeCredentialId is undefined.
  const active = allEntries.find(
    (e) =>
      e.id === activeAgentId &&
      ("credentialId" in e ? e.credentialId : undefined) === activeCredentialId,
  );
  const isOnNango =
    active !== undefined
    && active.source === "builtin"
    && "isSupervisor" in active
    && active.isSupervisor === true;
  const ActiveIcon = isOnNango
    ? Sparkles
    : active?.type === "team"
      ? Users
      : Bot;
  const activeGroup = isOnNango ? undefined : active?.credentialName;
  const activeName = active?.name ?? activeAgentId;

  const hasBackend = backendEntries.length > 0;
  const hasBuiltin = visibleBuiltin.length > 0;

  // Which group key owns the current active agent?
  const activeGroupKey: string | undefined =
    active === undefined
      ? undefined
      : active.source === "builtin"
        ? "__builtin__"
        : active.credentialName;

  // User-toggled overrides. Only records explicit clicks; groups
  // not present here fall through to the default policy below.
  // Hooks must be called before any early return.
  const [userToggled, setUserToggled] = useState<Record<string, boolean>>({});

  const toggle = useCallback((key: string) => {
    setUserToggled((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Effective expanded state: user toggle wins; otherwise the active
  // agent's group and BuiltIn are expanded, the rest collapsed.
  // Computed inline so active-agent changes (initial race, user pick,
  // enterNango) are reflected without an effect.
  const expanded: Record<string, boolean> = {};
  for (const key of backendGroups.keys()) {
    expanded[key] = key in userToggled
      ? userToggled[key]
      : key === activeGroupKey;
  }
  if (hasBuiltin) {
    expanded["__builtin__"] = "__builtin__" in userToggled
      ? userToggled["__builtin__"]
      : true;
  }

  if (allEntries.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs",
          "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          isOnNango
            ? "bg-amber-500/60 text-amber-950 hover:bg-amber-500/80 dark:bg-amber-500/60 dark:text-amber-100 dark:hover:bg-amber-500/80"
            : "hover:bg-muted",
        )}
      >
        <ActiveIcon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isOnNango ? "text-amber-950 dark:text-amber-100" : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 truncate">
          {activeGroup && (
            <span className="text-muted-foreground">{activeGroup} / </span>
          )}
          <span className={cn(isOnNango ? "" : "text-foreground")}>
            {isOnNango ? "Nango" : activeName}
          </span>
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="bottom" className="w-52">
        {[...backendGroups.entries()]
          .sort(([a], [b]) => alphabeticCompare(a, b))
          .map(([groupName, entries], gi) => (
          <Fragment key={groupName}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <GroupHeader
                label={groupName}
                count={entries.length}
                expanded={expanded[groupName] ?? false}
                onToggle={() => toggle(groupName)}
              />
              {expanded[groupName] && [...entries]
                .sort((a, b) => alphabeticCompare(a.name, b.name))
                .map((e) => {
                const key = agentKey(e.credentialId, e.id);
                const isActive =
                  activeAgentId === e.id &&
                  activeAgentType === e.type &&
                  activeCredentialId === e.credentialId;
                return (
                  <DropdownMenuItem
                    key={key}
                    className={cn("gap-2 pl-5 text-xs", isActive && "bg-accent text-accent-foreground")}
                    onClick={() =>
                      onSelect(e.id, e.type, "backend", e.credentialId, e.provider)
                    }
                  >
                    {e.type === "team" ? (
                      <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </Fragment>
        ))}

        {hasBuiltin && (
          <>
            {hasBackend && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <GroupHeader
                label="BuiltIn"
                count={sortedVisibleBuiltin.length}
                expanded={expanded["__builtin__"] ?? false}
                onToggle={() => toggle("__builtin__")}
              />
              {expanded["__builtin__"] && sortedVisibleBuiltin.map((b) => (
                <DropdownMenuItem
                  key={b.id}
                  className={cn(
                    "gap-2 pl-5 text-xs",
                    activeAgentId === b.id &&
                      activeAgentType === "agent" &&
                      activeCredentialId === undefined &&
                      "bg-accent text-accent-foreground",
                  )}
                  onClick={() => onSelect(b.id, "agent", "builtin")}
                >
                  <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{b.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
