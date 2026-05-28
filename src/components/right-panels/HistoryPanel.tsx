"use client";

import { RefreshCw, Star, Trash2, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SessionDescriptor } from "@/lib/backends/types";
import { useWorkspaceStore } from "@/store/workspace";
import { useSidebarStore } from "@/store/sidebar";
import { cn } from "@/lib/utils";

/**
 * Thread switching note (v2 migration)
 */

// helpers

type TimeGroup = "pinned" | "today" | "yesterday" | "last7days";

const GROUP_LABELS: Record<TimeGroup, string> = {
  pinned: "Pinned",
  today: "Today",
  yesterday: "Yesterday",
  last7days: "Last 7 days",
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function classifySession(ts: string): "today" | "yesterday" | "last7days" | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const todayStart = startOfDay(new Date());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const sevenDaysStart = new Date(todayStart.getTime() - 6 * 86_400_000);
  if (d >= todayStart) return "today";
  if (d >= yesterdayStart) return "yesterday";
  if (d >= sevenDaysStart) return "last7days";
  return null;
}

function groupSessions(
  sessions: SessionDescriptor[],
  pinnedIds: Set<string>,
): Partial<Record<TimeGroup, SessionDescriptor[]>> {
  const groups: Partial<Record<TimeGroup, SessionDescriptor[]>> = {};
  for (const s of sessions) {
    if (pinnedIds.has(s.session_id)) {
      (groups.pinned ??= []).push(s);
      continue;
    }
    const group = classifySession(s.updated_at ?? s.created_at);
    if (!group) continue;
    (groups[group] ??= []).push(s);
  }
  return groups;
}

interface ListResult {
  data: SessionDescriptor[] | null;
  error: string | null;
}

interface DeleteResult {
  ok: boolean;
  error: string | null;
}

async function fetchThreads(entityId: string | null): Promise<ListResult> {
  try {
    const url = entityId
      ? `/api/threads?entityId=${encodeURIComponent(entityId)}`
      : "/api/threads";
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      return { data: null, error: `Failed to load conversations (${res.status}).` };
    }
    const json = (await res.json()) as SessionDescriptor[];
    return { data: json, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : "Failed to load conversations.",
    };
  }
}

async function deleteThread(threadId: string): Promise<DeleteResult> {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });
    if (res.status === 204) return { ok: true, error: null };
    if (res.ok) return { ok: true, error: null };
    return { ok: false, error: `Delete failed (${res.status}).` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Delete failed.",
    };
  }
}

// component

/**
 * HistoryPanelBody — headerless history body for the tabbed RightPanel.
 */
export function HistoryPanelBody(): ReactNode {
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);

  if (!activeAgentId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-center text-sm text-muted-foreground">
          Select an agent to view history.
        </p>
      </div>
    );
  }

  return <HistoryPanelContent />;
}

function HistoryPanelContent(): ReactNode {
  // Per-field selectors so unrelated store mutations (e.g. agent list
  // refresh, artifact open/close) do not re-render the whole history
  // surface and re-issue the sessions fetch effect.
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const activeAgentType = useWorkspaceStore((s) => s.activeAgentType);
  // Read `runtimeThreadId` to determine which history row is "active"
  // (i.e. the thread the user is currently chatting in). Write paths
  // differ: handleSelectSession promotes to `explicitThreadId` (forces
  // CopilotChat to enter history-restore mode); handleDelete clears
  // both fields when the active row is removed.
  // @see docs/chat-flow-audit.md §1.11
  const threadId = useWorkspaceStore((s) => s.runtimeThreadId);
  const explicitThreadId = useWorkspaceStore((s) => s.explicitThreadId);
  const setRuntimeThreadId = useWorkspaceStore((s) => s.setRuntimeThreadId);
  const setExplicitThreadId = useWorkspaceStore((s) => s.setExplicitThreadId);
  const bumpChatEpoch = useWorkspaceStore((s) => s.bumpChatEpoch);
  const startFreshChat = useWorkspaceStore((s) => s.startFreshChat);
  const pinnedSessions = useWorkspaceStore((s) => s.pinnedSessions);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const [sessions, setSessions] = useState<SessionDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!activeAgentId) {
        if (!cancelled) { setSessions([]); setError(null); }
        return;
      }
      // Workflows are one-shot runs, not chat threads — no session list.
      if (activeAgentType === "workflow") {
        if (!cancelled) { setSessions([]); setError(null); }
        return;
      }
      setLoading(true);
      setError(null);
      // Our own PG (`/api/threads`), not the upstream agent platform's `/sessions`.
      // boundary is enforced; we just pass the active agent id as a
      // narrowing filter so the panel only shows threads anchored to
      // the agent currently in the chat surface.
      const result = await fetchThreads(activeAgentId);
      if (!cancelled) {
        setSessions(result.data ?? []);
        setError(result.error);
        setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [activeAgentId, activeAgentType, revision]);

  const setRightTab = useSidebarStore((s) => s.setRightTab);

  function handleSelectSession(sid: string) {
    // Short-circuit ONLY when we're already in explicit mode for this
    // exact thread. We deliberately do NOT short-circuit on
    // `sid === runtimeThreadId && explicitThreadId == null` (i.e.
    // fresh-mode active thread): promoting that case to explicit
    // forces a /connect + DB replay, ensuring the message list comes
    // from the same source as a fresh history click would. This
    // closes a subtle UI consistency gap where the in-memory
    // fresh-mode `agent.messages` could diverge from the DB-replayed
    // version if the reconstruction pipeline ever adds branches that
    // the in-memory path doesn't.
    if (sid === threadId && sid === explicitThreadId) {
      setRightTab("chat");
      return;
    }
    // History click → explicit mode. Set both fields:
    //  - explicit drives <CopilotChat threadId>, triggering /connect
    //    and DB replay.
    //  - runtime keeps "what thread am I in?" coherent for outcomes,
    //    save flows, URL sync.
    setExplicitThreadId(sid);
    setRuntimeThreadId(sid);
    setRightTab("chat");
  }

  async function handleDelete(sid: string) {
    setError(null);
    const previousSessions: SessionDescriptor[] = sessions;
    const isActiveThread: boolean = sid === threadId;

    // Optimistic removal
    setSessions((prev) => prev.filter((s) => s.session_id !== sid));
    if (isActiveThread) {
      // Atomically clear both fields + bump epoch — equivalent to
      // pressing "New Chat" so the chat surface returns to welcome.
      startFreshChat();
    }

    const result = await deleteThread(sid);
    if (result.ok) {
      return;
    }

    // Rollback when delete fails. Restore the deleted thread as an
    // explicit (history-restore) mount so /connect replays the DB
    // state cleanly. Bump the epoch for symmetry — the explicit prop
    // change alone would force re-render, but bumping keeps the state
    // machine consistent with the forward path (every transition into
    // a "fresh chat surface" goes through an epoch increment).
    setSessions(previousSessions);
    if (isActiveThread) {
      setRuntimeThreadId(sid);
      setExplicitThreadId(sid);
      bumpChatEpoch();
    }
    setError(result.error);
  }

  const grouped = groupSessions(sessions, pinnedSessions);
  const hasAny = (Object.keys(grouped) as TimeGroup[]).some(
    (g) => (grouped[g]?.length ?? 0) > 0,
  );

  // All groups open by default
  const [openGroups, setOpenGroups] = useState<Set<TimeGroup>>(
    () => new Set(["pinned", "today", "yesterday", "last7days"]),
  );
  function toggleGroup(group: TimeGroup) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          onClick={() => setRevision((r) => r + 1)}
          disabled={loading}
          aria-label="Refresh sessions"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading && sessions.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="p-4 text-center text-xs text-destructive">{error}</p>
        ) : !hasAny ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            No past conversations.
          </p>
        ) : (
          <div className="py-1">
            {(["pinned", "today", "yesterday", "last7days"] as TimeGroup[]).map((group) => {
              const items = grouped[group];
              if (!items?.length) return null;
              const isOpen = openGroups.has(group);
              return (
                <div key={group}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group)}
                    className="flex w-full items-center gap-1 bg-muted/40 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight
                      className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")}
                    />
                    <span>{GROUP_LABELS[group]}</span>
                    <span className="text-[10px] text-muted-foreground/60">({items.length})</span>
                  </button>
                  {isOpen && (
                    <ul className="space-y-0.5 py-0.5">
                      {items.map((s) => (
                        <SessionRow
                          key={s.session_id}
                          session={s}
                          active={s.session_id === threadId}
                          pinned={pinnedSessions.has(s.session_id)}
                          onSelect={handleSelectSession}
                          onPin={() => togglePin(s.session_id)}
                          onDelete={() => void handleDelete(s.session_id)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// sub-components

interface SessionRowProps {
  session: SessionDescriptor;
  active: boolean;
  pinned: boolean;
  onSelect: (sid: string) => void;
  onPin: () => void;
  onDelete: () => void;
}

function SessionRow({ session, active, pinned, onSelect, onPin, onDelete }: SessionRowProps) {
  return (
    <li className="group relative">
      <button
        type="button"
        className={cn(
          "flex w-full items-center rounded-md px-2 py-1.5 text-left hover:bg-accent pr-16",
          active && "bg-accent text-accent-foreground",
        )}
        onClick={() => onSelect(session.session_id)}
      >
        <span className="block min-w-0 flex-1 truncate text-sm">
          {session.session_name || session.session_id}
        </span>
      </button>

      {/* Action buttons — visible on group hover */}
      <div className={cn(
        "absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5",
        "opacity-0 group-hover:opacity-100 transition-opacity",
      )}>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6 shrink-0",
            pinned && "text-yellow-500 hover:text-yellow-500",
          )}
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          aria-label={pinned ? "Unpin conversation" : "Pin conversation"}
        >
          <Star className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          aria-label="Delete conversation"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}
