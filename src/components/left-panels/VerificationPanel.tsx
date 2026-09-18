"use client";

import { useState, useMemo, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  RefreshCw,
  Play,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight,
  SquarePen,
  Globe,
  Lock,
  SquarePlus,
  Folder,
  FolderOpen,
} from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { alphabeticCompare } from "@/lib/utils/sort";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import {
  verificationActions,
  type VerificationSuiteRow,
  type VerificationGroupRow,
  type PatchSuiteInput,
} from "@/store/verification";
import { VerificationSuiteDialog } from "@/components/main-panels/verification/VerificationSuiteDialog";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch data");
  return res.json();
};

interface GroupTreeItem {
  id: string; // group id or "ungrouped"
  name: string;
  isUngrouped: boolean;
  suites: VerificationSuiteRow[];
}

interface SuiteRowItemProps {
  suite: VerificationSuiteRow;
  active: boolean;
  onSelect: () => void;
  onRunSuite: (e: React.MouseEvent) => void;
  onToggleVisibility: (e: React.MouseEvent) => void;
  onEditSuite: (e: React.MouseEvent) => void;
  onDeleteSuite: (e: React.MouseEvent) => void;
  running: boolean;
  runDisabled?: boolean;
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
  runDisabled = false,
}: SuiteRowItemProps): ReactNode {
  const isPublic = suite.visibility === "public";
  const { canChangeVisibility, canDelete } = useResourcePermissions({
    source: "local" as const,
    visibility: suite.visibility,
    createdBy: suite.createdBy,
  });

  return (
    <div
      data-testid="panel-row"
      data-suite-id={suite.id}
      data-name={suite.name}
      data-visibility={suite.visibility}
      data-enabled={String(suite.enabled)}
      className={cn(
        "group flex cursor-pointer items-center justify-between pl-7 pr-2 py-1.5 text-xs transition-colors rounded select-none",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        !suite.enabled && "opacity-50",
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-1.5 min-w-0 pr-1 overflow-hidden" data-action="open-suite">
        <span className="truncate">{suite.name}</span>
        {suite.mcpServerName && !suite.name.includes(`(${suite.mcpServerName})`) && (
          <span
            className={cn(
              "shrink-0 rounded px-1 py-0.2 text-[9px] font-mono truncate max-w-[100px]",
              suite.mcpServerId
                ? "bg-muted/70 text-muted-foreground"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
            )}
          >
            {suite.mcpServerName}
          </span>
        )}
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
          disabled={running || !suite.enabled || runDisabled}
          title={runDisabled ? "Suite is detached from its MCP server" : "Run"}
          aria-label={`Run suite ${suite.name}`}
          data-action="run-suite"
          className="rounded p-0.5 text-muted-foreground/70 hover:text-emerald-500 transition-colors disabled:opacity-40 cursor-pointer"
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
            aria-label={isPublic ? `Set ${suite.name} to private` : `Set ${suite.name} to public`}
            data-action="toggle-visibility"
            className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
          >
            {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
          </button>
        )}

        <button
          type="button"
          onClick={onEditSuite}
          title="Edit"
          aria-label={`Edit ${suite.name}`}
          data-action="edit-suite"
          className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
        >
          <SquarePen className="h-3 w-3" />
        </button>

        {canDelete && (
          <button
            type="button"
            onClick={onDeleteSuite}
            title="Delete"
            aria-label={`Delete ${suite.name}`}
            data-action="delete-suite"
            className="rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors cursor-pointer"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface GroupNodeProps {
  group: GroupTreeItem;
  expanded: boolean;
  onToggleExpand: () => void;
  activeSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onRunGroup: (groupId: string, e: React.MouseEvent) => void;
  onRenameGroup: (group: GroupTreeItem, e: React.MouseEvent) => void;
  onRunSuite: (suiteId: string, e: React.MouseEvent) => void;
  onToggleSuiteVisibility: (suite: VerificationSuiteRow, e: React.MouseEvent) => void;
  onEditSuite: (suite: VerificationSuiteRow, e: React.MouseEvent) => void;
  onDeleteSuite: (suite: VerificationSuiteRow, e: React.MouseEvent) => void;
  runningGroupId: string | null;
  runningSuiteId: string | null;
}

function GroupNode({
  group,
  expanded,
  onToggleExpand,
  activeSuiteId,
  onSelectSuite,
  onRunGroup,
  onRenameGroup,
  onRunSuite,
  onToggleSuiteVisibility,
  onEditSuite,
  onDeleteSuite,
  runningGroupId,
  runningSuiteId,
}: GroupNodeProps): ReactNode {
  const isGroupRunning = runningGroupId === group.id;

  return (
    <div
      data-testid="server-group"
      data-group-node="true"
      data-group-id={group.id}
      data-name={group.name}
      className="select-none border-b border-border/40 last:border-0"
    >
      {/* Group Node Header */}
      <div
        className="group flex items-center justify-between px-2.5 py-1.5 transition-colors hover:bg-muted/30 text-xs cursor-pointer"
        onClick={onToggleExpand}
        data-action="toggle-expand"
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-violet-500/80 dark:text-violet-400/80 transition-colors" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-violet-500/80 dark:text-violet-400/80 transition-colors" />
          )}
          <span className="truncate font-medium hover:underline underline-offset-2">
            {group.name}
          </span>
          {group.suites.length > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.2 text-[9px] text-muted-foreground">
              {group.suites.length}
            </span>
          )}
        </div>

        {/* Group Actions */}
        {!group.isUngrouped && (
          <div className="flex shrink-0 items-center gap-1 ml-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={(e) => onRunGroup(group.id, e)}
              disabled={isGroupRunning || group.suites.length === 0}
              title="Run all suites in group"
              aria-label={`Run all suites for ${group.name}`}
              data-action="run-group"
              className="rounded p-0.5 text-muted-foreground/70 hover:text-emerald-500 transition-colors disabled:opacity-40 cursor-pointer"
            >
              {isGroupRunning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3 fill-current" />
              )}
            </button>

            <button
              type="button"
              onClick={(e) => onRenameGroup(group, e)}
              title="Rename group"
              aria-label={`Rename ${group.name}`}
              data-action="rename-group"
              className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
            >
              <SquarePen className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {/* Suites List */}
      {expanded && (
        <div className="flex flex-col py-0.5">
          {group.suites.length === 0 ? (
            <div className="pl-8 py-1 text-[11px] text-muted-foreground italic">
              No suites in this group.
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
                runDisabled={!suite.mcpServerId}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function VerificationPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  const activeSuiteMatch = pathname.match(/^\/verification\/([^/]+)/);
  const activeSuiteId =
    activeSuiteMatch && activeSuiteMatch[1] !== "server"
      ? activeSuiteMatch[1]
      : null;

  // 1. Fetch groups
  const {
    data: groupRows,
    error: groupError,
    isLoading: groupLoading,
    mutate: mutateGroups,
  } = useSWR<VerificationGroupRow[]>("/api/verification-groups", fetcher);

  // 2. Fetch suites
  const {
    data: suiteRows,
    error: suiteError,
    isLoading: suiteLoading,
    mutate: mutateSuites,
  } = useSWR<VerificationSuiteRow[]>("/api/verification-suites", fetcher);

  const [expandedGroupIds, setExpandedGroupIds] = useState<Record<string, boolean>>({});

  const toggleGroupExpand = (groupId: string, currentlyExpanded: boolean): void => {
    setExpandedGroupIds((prev) => ({
      ...prev,
      [groupId]: !currentlyExpanded,
    }));
  };

  const treeGroups = useMemo<GroupTreeItem[]>(() => {
    if (!suiteRows) return [];

    const suitesByGroup = new Map<string, VerificationSuiteRow[]>();
    const ungroupedSuites: VerificationSuiteRow[] = [];

    for (const suite of suiteRows) {
      if (suite.groupId) {
        const list = suitesByGroup.get(suite.groupId) ?? [];
        list.push(suite);
        suitesByGroup.set(suite.groupId, list);
      } else {
        ungroupedSuites.push(suite);
      }
    }

    const regularGroups: GroupTreeItem[] = (groupRows ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      isUngrouped: false,
      suites: (suitesByGroup.get(g.id) ?? []).sort((a, b) =>
        alphabeticCompare(a.name, b.name),
      ),
    }));

    regularGroups.sort((a, b) => alphabeticCompare(a.name, b.name));

    if (ungroupedSuites.length > 0) {
      regularGroups.push({
        id: "ungrouped",
        name: "Ungrouped",
        isUngrouped: true,
        suites: ungroupedSuites.sort((a, b) =>
          alphabeticCompare(a.name, b.name),
        ),
      });
    }

    return regularGroups;
  }, [groupRows, suiteRows]);

  const [runningGroupId, setRunningGroupId] = useState<string | null>(null);
  const [runningSuiteId, setRunningSuiteId] = useState<string | null>(null);

  const [createSuiteOpen, setCreateSuiteOpen] = useState<boolean>(false);
  const [editingSuite, setEditingSuite] = useState<VerificationSuiteRow | null>(null);
  const [deletingSuite, setDeletingSuite] = useState<VerificationSuiteRow | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<GroupTreeItem | null>(null);
  const [newGroupName, setNewGroupName] = useState<string>("");
  const [deleting, setDeleting] = useState<boolean>(false);
  const [renaming, setRenaming] = useState<boolean>(false);

  const handleStartGroupRun = async (groupId: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    setRunningGroupId(groupId);
    try {
      const res = await fetch("/api/verification-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Triggered group run");
    } catch {
      toast.error("Failed to start group run");
    } finally {
      setRunningGroupId(null);
    }
  };

  const handleStartSuiteRun = async (suiteId: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    setRunningSuiteId(suiteId);
    try {
      const res = await fetch("/api/verification-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Triggered suite run");
    } catch {
      toast.error("Failed to start suite run");
    } finally {
      setRunningSuiteId(null);
    }
  };

  const handleToggleSuiteVisibility = async (
    suite: VerificationSuiteRow,
    e: React.MouseEvent,
  ): Promise<void> => {
    e.stopPropagation();
    const next = suite.visibility === "public" ? "private" : "public";
    try {
      const res = await fetch(`/api/verification-suites/${suite.id}`, {
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

  const handleSuiteSave = async (updated: PatchSuiteInput): Promise<void> => {
    if (!editingSuite) return;
    try {
      await verificationActions.patch(editingSuite.id, updated);
      void mutateGroups();
      void mutateSuites();
      toast.success("Suite updated");
      setEditingSuite(null);
    } catch {
      toast.error("Failed to update suite");
    }
  };

  const handleSuiteDeleteConfirm = async (): Promise<void> => {
    if (!deletingSuite) return;
    setDeleting(true);
    try {
      await verificationActions.remove(deletingSuite.id);
      void mutateGroups();
      void mutateSuites();
      toast.success("Suite deleted");
      if (activeSuiteId === deletingSuite.id) {
        router.push("/verification");
      }
    } catch {
      toast.error("Failed to delete suite");
    } finally {
      setDeleting(false);
      setDeletingSuite(null);
    }
  };

  const handleRenameGroupConfirm = async (): Promise<void> => {
    if (!renamingGroup || !newGroupName.trim()) return;
    setRenaming(true);
    try {
      const ok = await verificationActions.renameGroup(renamingGroup.id, newGroupName.trim());
      if (ok) {
        toast.success("Group renamed");
        void mutateGroups();
        void mutateSuites();
        setRenamingGroup(null);
      } else {
        toast.error("Failed to rename group");
      }
    } catch {
      toast.error("Failed to rename group");
    } finally {
      setRenaming(false);
    }
  };

  const isTreeLoading = groupLoading || suiteLoading;
  const treeError = groupError || suiteError;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* MCP Verification Header + Action Toolbar */}
      <div className="flex h-9 items-center justify-between border-b bg-muted/40 px-3 py-1.5">
        <span className="text-xs font-semibold tracking-tight text-foreground">
          MCP Verification
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => setCreateSuiteOpen(true)}
            aria-label="New suite"
            title="New suite"
            data-testid="new-suite-button"
          >
            <SquarePlus className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => {
              void mutateGroups();
              void mutateSuites();
            }}
            disabled={isTreeLoading}
            aria-label="Refresh list"
            title="Refresh list"
            data-testid="refresh-suites-button"
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
              {treeError.message || "Failed to load verification targets."}
            </p>
          )}

          {isTreeLoading && treeGroups.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground flex justify-center items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading targets…
            </div>
          ) : treeGroups.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No verification targets or suites found.
            </div>
          ) : (
            treeGroups.map((group) => {
              const isExpanded =
                expandedGroupIds[group.id] ??
                (activeSuiteId ? group.suites.some((s) => s.id === activeSuiteId) : true);
              return (
                <GroupNode
                  key={group.id}
                  group={group}
                  expanded={isExpanded}
                  onToggleExpand={() => toggleGroupExpand(group.id, isExpanded)}
                  activeSuiteId={activeSuiteId}
                  onSelectSuite={(suiteId) => router.push(`/verification/${suiteId}`)}
                  onRunGroup={handleStartGroupRun}
                  onRenameGroup={(g) => {
                    setRenamingGroup(g);
                    setNewGroupName(g.name);
                  }}
                  onRunSuite={handleStartSuiteRun}
                  onToggleSuiteVisibility={handleToggleSuiteVisibility}
                  onEditSuite={(suite) => setEditingSuite(suite)}
                  onDeleteSuite={setDeletingSuite}
                  runningGroupId={runningGroupId}
                  runningSuiteId={runningSuiteId}
                />
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* New Suite Dialog */}
      <VerificationSuiteDialog
        open={createSuiteOpen}
        onOpenChange={setCreateSuiteOpen}
        onCreated={(created) => {
          void mutateSuites();
          void mutateGroups();
          router.push(`/verification/${created.id}`);
        }}
      />

      {/* Edit Suite Dialog */}
      {editingSuite && (
        <VerificationSuiteDialog
          open
          onOpenChange={(o) => {
            if (!o) setEditingSuite(null);
          }}
          suite={editingSuite}
          onUpdated={handleSuiteSave}
        />
      )}

      {/* Rename Group Dialog */}
      <Dialog
        open={renamingGroup !== null}
        onOpenChange={(o) => {
          if (!o && !renaming) setRenamingGroup(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Group</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="rename-group-name">Group Name</Label>
            <Input
              id="rename-group-name"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              disabled={renaming}
              maxLength={64}
              autoFocus
              className="mt-1.5"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenamingGroup(null)}
              disabled={renaming}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleRenameGroupConfirm()}
              disabled={renaming || !newGroupName.trim()}
            >
              {renaming ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Suite Dialog */}
      <AlertDialog
        open={deletingSuite !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) setDeletingSuite(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Verification Suite</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete suite <strong>{deletingSuite?.name}</strong> and all its test cases? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleSuiteDeleteConfirm();
              }}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90 cursor-pointer"
              data-testid="confirm-delete-suite-button"
            >
              {deleting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

