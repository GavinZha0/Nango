"use client";

import { Pencil, Star, Trash2, ChevronRight } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SessionDescriptor } from "@/lib/backends/types";
import {
  HISTORY_GROUP_LABELS,
  HISTORY_TIME_GROUPS,
  MAX_THREAD_TITLE_CHARS,
  groupHistorySessions,
  type HistoryTimeGroup,
} from "@/lib/threads/helpers";
import { useWorkspaceStore } from "@/store/workspace";
import { useSidebarStore } from "@/store/sidebar";
import { cn } from "@/lib/utils";

interface ListResult {
  data: SessionDescriptor[] | null;
  error: string | null;
}

interface DeleteResult {
  ok: boolean;
  error: string | null;
}

interface ThreadPatchResponse {
  session_id: string;
  session_name: string;
  pinned: boolean;
  pinned_at: string | null;
  custom_title: string | null;
}

interface PatchResult {
  data: ThreadPatchResponse | null;
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

async function patchThreadMetadata(
  threadId: string,
  payload: { pinned?: boolean; title?: string | null },
): Promise<PatchResult> {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let message = `Update failed (${res.status}).`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body?.message) message = body.message;
      } catch {
        // Keep status-based fallback message.
      }
      return { data: null, error: message };
    }
    const json = (await res.json()) as ThreadPatchResponse;
    return { data: json, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : "Update failed.",
    };
  }
}

async function deleteThread(threadId: string): Promise<DeleteResult> {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });
    if (res.status === 204 || res.ok) return { ok: true, error: null };
    return { ok: false, error: `Delete failed (${res.status}).` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Delete failed.",
    };
  }
}

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
  // Per-field selectors so unrelated store mutations do not re-issue the fetch effect.
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const activeAgentType = useWorkspaceStore((s) => s.activeAgentType);
  // Read `runtimeThreadId` for active-row highlighting; writes split between
  // `explicitThreadId` (history restore) and `startFreshChat` (delete active).
  // See docs/chat-flow-audit.md.
  const threadId = useWorkspaceStore((s) => s.runtimeThreadId);
  const explicitThreadId = useWorkspaceStore((s) => s.explicitThreadId);
  const setRuntimeThreadId = useWorkspaceStore((s) => s.setRuntimeThreadId);
  const setExplicitThreadId = useWorkspaceStore((s) => s.setExplicitThreadId);
  const bumpChatEpoch = useWorkspaceStore((s) => s.bumpChatEpoch);
  const startFreshChat = useWorkspaceStore((s) => s.startFreshChat);
  const clearChatError = useWorkspaceStore((s) => s.clearChatError);
  const historyRevision = useSidebarStore((s) => s.historyRevision);
  const rightTab = useSidebarStore((s) => s.rightTab);
  const setRightTab = useSidebarStore((s) => s.setRightTab);

  const [sessions, setSessions] = useState<SessionDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rename dialog state
  const [renamingSession, setRenamingSession] = useState<SessionDescriptor | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!activeAgentId) {
        if (!cancelled) {
          setSessions([]);
          setError(null);
        }
        return;
      }
      // Workflows are one-shot runs, not chat threads — no session list.
      if (activeAgentType === "workflow") {
        if (!cancelled) {
          setSessions([]);
          setError(null);
        }
        return;
      }
      setLoading(true);
      setError(null);
      const result = await fetchThreads(activeAgentId);
      if (!cancelled) {
        setSessions(result.data ?? []);
        setError(result.error);
        setLoading(false);
      }
    }

    if (rightTab === "history") {
      void load();
    }
    return () => {
      cancelled = true;
    };
  }, [activeAgentId, activeAgentType, historyRevision, rightTab]);

  function handleSelectSession(sid: string) {
    // Short-circuit ONLY when already in explicit history-restore mode for this thread.
    if (sid === threadId && sid === explicitThreadId) {
      clearChatError();
      setRightTab("chat");
      return;
    }
    clearChatError();
    setExplicitThreadId(sid);
    setRuntimeThreadId(sid);
    setRightTab("chat");
  }

  async function handleTogglePin(session: SessionDescriptor) {
    setError(null);
    const previousSessions = sessions;
    const nextPinned = !session.pinned;
    const optimisticPinnedAt = nextPinned ? new Date().toISOString() : null;

    setSessions((prev) =>
      prev.map((s) =>
        s.session_id === session.session_id
          ? { ...s, pinned: nextPinned, pinned_at: optimisticPinnedAt }
          : s,
      ),
    );

    const result = await patchThreadMetadata(session.session_id, {
      pinned: nextPinned,
    });
    if (result.data) {
      const updated = result.data;
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === updated.session_id
            ? {
                ...s,
                session_name: updated.session_name,
                pinned: updated.pinned,
                pinned_at: updated.pinned_at,
                custom_title: updated.custom_title,
              }
            : s,
        ),
      );
      return;
    }

    setSessions(previousSessions);
    setError(result.error);
  }

  function openRenameDialog(session: SessionDescriptor) {
    setRenamingSession(session);
    setRenameInput(session.custom_title ?? session.session_name ?? "");
    setRenameError(null);
  }

  async function handleRenameSubmit(e: FormEvent) {
    e.preventDefault();
    if (!renamingSession || renameSaving) return;

    const trimmed = renameInput.trim();
    if (trimmed.length > MAX_THREAD_TITLE_CHARS) {
      setRenameError(`Title must not exceed ${MAX_THREAD_TITLE_CHARS} characters.`);
      return;
    }

    setRenameSaving(true);
    setRenameError(null);
    const result = await patchThreadMetadata(renamingSession.session_id, {
      title: trimmed.length === 0 ? null : trimmed,
    });
    setRenameSaving(false);

    if (result.data) {
      const updated = result.data;
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === updated.session_id
            ? {
                ...s,
                session_name: updated.session_name,
                pinned: updated.pinned,
                pinned_at: updated.pinned_at,
                custom_title: updated.custom_title,
              }
            : s,
        ),
      );
      setRenamingSession(null);
      return;
    }

    setRenameError(result.error ?? "Failed to rename conversation.");
  }

  async function handleDelete(sid: string) {
    setError(null);
    const previousSessions: SessionDescriptor[] = sessions;
    const isActiveThread: boolean = sid === threadId;

    setSessions((prev) => prev.filter((s) => s.session_id !== sid));
    if (isActiveThread) {
      startFreshChat();
    }

    const result = await deleteThread(sid);
    if (result.ok) {
      return;
    }

    setSessions(previousSessions);
    if (isActiveThread) {
      setRuntimeThreadId(sid);
      setExplicitThreadId(sid);
      bumpChatEpoch();
    }
    setError(result.error);
  }

  const grouped = groupHistorySessions(sessions);
  const hasAny = HISTORY_TIME_GROUPS.some((g) => (grouped[g]?.length ?? 0) > 0);

  const [openGroups, setOpenGroups] = useState<Set<HistoryTimeGroup>>(
    () => new Set(["pinned", "today", "yesterday", "last7days"]),
  );
  function toggleGroup(group: HistoryTimeGroup) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const [bulkDeleteGroup, setBulkDeleteGroup] = useState<HistoryTimeGroup | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const bulkDeleteCount = bulkDeleteGroup
    ? (grouped[bulkDeleteGroup] ?? []).filter((s) => !s.pinned).length
    : 0;

  async function handleBulkDelete(): Promise<void> {
    if (!bulkDeleteGroup) return;
    const items = grouped[bulkDeleteGroup] ?? [];
    const toDelete = items.filter((s) => !s.pinned);
    if (toDelete.length === 0) {
      setBulkDeleteGroup(null);
      return;
    }

    setBulkDeleting(true);
    setError(null);
    const previousSessions = sessions;
    const deleteIds = new Set(toDelete.map((s) => s.session_id));

    setSessions((prev) => prev.filter((s) => !deleteIds.has(s.session_id)));
    if (threadId && deleteIds.has(threadId)) {
      startFreshChat();
    }

    const results = await Promise.all(
      toDelete.map((s) => deleteThread(s.session_id)),
    );
    const anyFailed = results.some((r) => !r.ok);

    if (anyFailed) {
      // Rollback all — simpler than partial rollback.
      setSessions(previousSessions);
      if (threadId && deleteIds.has(threadId)) {
        setRuntimeThreadId(threadId);
        setExplicitThreadId(threadId);
        bumpChatEpoch();
      }
      setError("Some conversations could not be deleted.");
    }

    setBulkDeleting(false);
    setBulkDeleteGroup(null);
  }

  return (
    <div className="flex h-full flex-col">
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
            {HISTORY_TIME_GROUPS.map((group) => {
              const items = grouped[group];
              if (!items?.length) return null;
              const isOpen = openGroups.has(group);
              const showGroupDelete = group !== "pinned";
              return (
                <div key={group} data-testid={`history-group-${group}`}>
                  <div className="group/header flex items-center bg-muted/40 px-2 py-1.5">
                    <button
                      type="button"
                      data-testid={`history-group-toggle-${group}`}
                      onClick={() => toggleGroup(group)}
                      className="flex flex-1 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 transition-transform",
                          isOpen && "rotate-90",
                        )}
                      />
                      <span>{HISTORY_GROUP_LABELS[group]}</span>
                      <span className="text-[10px] text-muted-foreground/60">
                        ({items.length})
                      </span>
                    </button>
                    {showGroupDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`delete-group-${group}`}
                        className="h-5 w-5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/header:opacity-100"
                        onClick={() => setBulkDeleteGroup(group)}
                        aria-label={`Delete ${HISTORY_GROUP_LABELS[group]}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  {isOpen && (
                    <ul className="space-y-0.5 py-0.5">
                      {items.map((s) => (
                        <SessionRow
                          key={s.session_id}
                          session={s}
                          active={s.session_id === threadId}
                          pinned={Boolean(s.pinned)}
                          onSelect={handleSelectSession}
                          onRename={() => openRenameDialog(s)}
                          onPin={() => void handleTogglePin(s)}
                          onDelete={() => void handleDelete(s.session_id)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}

            <Dialog
              open={renamingSession !== null}
              onOpenChange={(open) => {
                if (!open && !renameSaving) {
                  setRenamingSession(null);
                  setRenameError(null);
                }
              }}
            >
              <DialogContent className="sm:max-w-md">
                <form onSubmit={(e) => void handleRenameSubmit(e)}>
                  <DialogHeader>
                    <DialogTitle>Rename conversation</DialogTitle>
                    <DialogDescription>
                      Set a custom name. Leave empty to restore the default title.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="my-4 space-y-2">
                    <Label htmlFor="rename-session-input">Title</Label>
                    <Input
                      id="rename-session-input"
                      data-testid="rename-session-input"
                      value={renameInput}
                      maxLength={MAX_THREAD_TITLE_CHARS}
                      onChange={(e) => {
                        setRenameInput(e.target.value);
                        if (renameError) setRenameError(null);
                      }}
                      placeholder="Enter conversation title"
                      disabled={renameSaving}
                      autoFocus
                    />
                    {renameError && (
                      <p className="text-xs text-destructive">{renameError}</p>
                    )}
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setRenamingSession(null);
                        setRenameError(null);
                      }}
                      disabled={renameSaving}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      data-testid="rename-session-submit"
                      disabled={renameSaving}
                    >
                      {renameSaving ? "Saving…" : "Save"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            <AlertDialog
              open={bulkDeleteGroup !== null}
              onOpenChange={(open) => {
                if (!open) setBulkDeleteGroup(null);
              }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Delete {bulkDeleteGroup ? HISTORY_GROUP_LABELS[bulkDeleteGroup] : ""} conversations?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {bulkDeleteCount} conversation{bulkDeleteCount !== 1 ? "s" : ""} will
                    be permanently deleted. Pinned conversations will be kept.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void handleBulkDelete()}
                    disabled={bulkDeleting || bulkDeleteCount === 0}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {bulkDeleting ? "Deleting…" : `Delete ${bulkDeleteCount}`}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface SessionRowProps {
  session: SessionDescriptor;
  active: boolean;
  pinned: boolean;
  onSelect: (sid: string) => void;
  onRename: () => void;
  onPin: () => void;
  onDelete: () => void;
}

function SessionRow({
  session,
  active,
  pinned,
  onSelect,
  onRename,
  onPin,
  onDelete,
}: SessionRowProps) {
  const sessionTitle = session.session_name || session.session_id;
  return (
    <li
      className="group relative"
      data-testid="history-session-item"
      data-session-id={session.session_id}
      data-session-name={sessionTitle}
    >
      <button
        type="button"
        className={cn(
          "flex w-full items-center rounded-md px-2 py-1.5 pr-24 text-left hover:bg-accent",
          active && "bg-accent text-accent-foreground",
        )}
        onClick={() => onSelect(session.session_id)}
      >
        <span className="block min-w-0 flex-1 truncate text-sm">
          {sessionTitle}
        </span>
      </button>

      <div
        className={cn(
          "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5",
          "opacity-0 transition-opacity group-hover:opacity-100",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          data-testid="session-rename-button"
          data-action="rename"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          aria-label={`Rename conversation ${sessionTitle}`}
          title="Rename"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="session-pin-button"
          data-action="pin"
          className={cn(
            "h-6 w-6 shrink-0",
            pinned && "text-yellow-500 hover:text-yellow-500",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
          aria-label={
            pinned
              ? `Unpin conversation ${sessionTitle}`
              : `Pin conversation ${sessionTitle}`
          }
          title={pinned ? "Unpin" : "Pin"}
        >
          <Star className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="session-delete-button"
          data-action="delete"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete conversation ${sessionTitle}`}
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}
