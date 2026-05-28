"use client";

import { Fragment } from "react";
import type { ReactNode } from "react";
import { Bot, ChevronDown, Sparkles, Users } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentKey } from "@/lib/backends/facade";
import type { EntityKind } from "@/lib/backends/types";
import { cn } from "@/lib/utils";
import type { BuiltinAgentRow } from "@/components/main-panels/BuiltinAgentEditor";

/**
 * AgentSelector — compact dropdown that lists every visible backend
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
  // The supervisor is hidden from dropdown items but kept in lookup for active-name resolution.
  const enabledBuiltin = builtinAgents.filter((b) => b.enabled);
  const visibleBuiltin = enabledBuiltin.filter((b) => b.isSupervisor !== true);

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
    // Include supervisor for active-name resolution.
    ...enabledBuiltin.map((b) => ({
      id: b.id,
      name: b.name,
      type: "agent" as const,
      source: "builtin" as const,
      credentialName: b.isSupervisor === true ? "Nango" : "BuiltIn",
      isSupervisor: b.isSupervisor === true,
    })),
  ];

  if (allEntries.length === 0) return null;

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
        {[...backendGroups.entries()].map(([groupName, entries], gi) => (
          <Fragment key={groupName}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs">{groupName}</DropdownMenuLabel>
              {entries.map((e) => {
                const key = agentKey(e.credentialId, e.id);
                const isActive =
                  activeAgentId === e.id &&
                  activeAgentType === e.type &&
                  activeCredentialId === e.credentialId;
                return (
                  <DropdownMenuItem
                    key={key}
                    className={cn("gap-2 text-xs", isActive && "bg-accent text-accent-foreground")}
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
              <DropdownMenuLabel className="text-xs">BuiltIn</DropdownMenuLabel>
              {visibleBuiltin.map((b) => (
                <DropdownMenuItem
                  key={b.id}
                  className={cn(
                    "gap-2 text-xs",
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
