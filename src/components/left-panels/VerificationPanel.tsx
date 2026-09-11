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
} from "lucide-react";
import { MCPIcon } from "@/components/icons/mcp-icon";
import { toast } from "sonner";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { alphabeticCompare } from "@/lib/utils/sort";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";
import {
  verificationActions,
  type VerificationSuiteRow,
  type VerificationServerRow,
} from "@/store/verification";
import { VerificationSuiteDialog } from "@/components/main-panels/verification/VerificationSuiteDialog";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch data");
  return res.json();
};

interface ServerTreeGroup {
  id: string; // mcpServerId — or a `detached:<name>` synthetic key when the server row is gone
  name: string;
  serverTitle: string | null;
  serverDescription: string | null;
  enabled: boolean;
  /** True for groups whose MCP server row was deleted — Run server is disabled. */
  detached: boolean;
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
  /** True when the suite is detached from a deleted MCP server — Run is greyed out. */
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
      <div className="flex items-center gap-1.5 min-w-0 pr-1" data-action="open-suite">
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
          disabled={running || !suite.enabled || runDisabled}
          title={runDisabled ? "Suite is detached from its MCP server" : "Run"}
          aria-label={`Run suite ${suite.name}`}
          data-action="run-suite"
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
            aria-label={isPublic ? `Set ${suite.name} to private` : `Set ${suite.name} to public`}
            data-action="toggle-visibility"
            className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors"
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
          className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors"
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
            className="rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface ServerGroupNodeProps {
  group: ServerTreeGroup;
  expanded: boolean;
  onToggleExpand: () => void;
  activeSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onRunServer: (serverId: string, e: React.MouseEvent) => void;
  onRunSuite: (suiteId: string, e: React.MouseEvent) => void;
  onToggleSuiteVisibility: (suite: VerificationSuiteRow, e: React.MouseEvent) => void;
  onEditSuite: (suite: VerificationSuiteRow, e: React.MouseEvent) => void;
  onDeleteSuite: (suite: VerificationSuiteRow, e: React.MouseEvent) => void;
  onDeleteServer: (server: ServerTreeGroup, e: React.MouseEvent) => void;
  runningServerId: string | null;
  runningSuiteId: string | null;
}

function ServerGroupNode({
  group,
  expanded,
  onToggleExpand,
  activeSuiteId,
  onSelectSuite,
  onRunServer,
  onRunSuite,
  onToggleSuiteVisibility,
  onEditSuite,
  onDeleteSuite,
  onDeleteServer,
  runningServerId,
  runningSuiteId,
}: ServerGroupNodeProps): ReactNode {
  const displayName = group.serverTitle || group.name;
  const isServerRunning = runningServerId === group.id;

  return (
    <div
      data-testid="server-group"
      data-server-id={group.id}
      data-name={displayName}
      className="select-none border-b border-border/40 last:border-0"
    >
      {/* Level 1: Server Node */}
      <div
        className={cn(
          "group flex items-center justify-between px-2.5 py-1.5 transition-colors hover:bg-muted/30 text-xs cursor-pointer",
          !group.enabled && "opacity-50",
        )}
        onClick={onToggleExpand}
        data-action="toggle-expand"
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <MCPIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium hover:underline underline-offset-2">
            {displayName}
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
            onClick={(e) => onRunServer(group.id, e)}
            disabled={isServerRunning || !group.enabled || group.detached}
            title={group.detached ? "Server deleted" : "Run"}
            aria-label={`Run all suites for ${displayName}`}
            data-action="run-server"
            className="rounded p-0.5 text-muted-foreground/70 hover:text-emerald-500 transition-colors disabled:opacity-40"
          >
            {isServerRunning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
          </button>

          <button
            type="button"
            onClick={(e) => onDeleteServer(group, e)}
            title="Delete"
            aria-label={`Delete verification data for ${displayName}`}
            data-action="delete-server"
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

  // Derive active suite ID from /verification/[id]
  const activeSuiteMatch = pathname.match(/^\/verification\/([^/]+)/);
  const activeSuiteId = activeSuiteMatch && activeSuiteMatch[1] !== "server" ? activeSuiteMatch[1] : null;

  // 1. Fetch servers
  const { data: serverRows, error: serverError, isLoading: serverLoading, mutate: mutateServers } = useSWR<VerificationServerRow[]>(
    "/api/verification-servers",
    fetcher,
  );

  // 2. Fetch suites
  const { data: suiteRows, error: suiteError, isLoading: suiteLoading, mutate: mutateSuites } = useSWR<VerificationSuiteRow[]>(
    "/api/verification-suites",
    fetcher,
  );

  const [expandedServerIds, setExpandedServerIds] = useState<Record<string, boolean>>({});

  const toggleServerExpand = (serverId: string, currentlyExpanded: boolean): void => {
    setExpandedServerIds((prev) => ({
      ...prev,
      [serverId]: !currentlyExpanded,
    }));
  };

  // Build tree grouping (alphabetical sort on servers and suites, filter out empty servers)
  // Suites whose MCP server row was deleted (mcpServerId NULL) are grouped
  // under their denormalized mcpServerName snapshot so the two-level
  // server -> suite hierarchy and its display names survive server
  // deletion; only the Run buttons on those suites are greyed out.
  const treeGroups = useMemo<ServerTreeGroup[]>(() => {
    if (!serverRows) return [];

    const suitesByServer = new Map<string, VerificationSuiteRow[]>();
    const detachedByName = new Map<string, VerificationSuiteRow[]>();
    for (const suite of suiteRows ?? []) {
      const serverId = (suite as unknown as { mcpServerId?: string }).mcpServerId;
      if (serverId) {
        const list = suitesByServer.get(serverId) ?? [];
        list.push(suite);
        suitesByServer.set(serverId, list);
      } else {
        const serverName =
          (suite as unknown as { mcpServerName?: string | null }).mcpServerName ||
          "Unknown Server";
        const list = detachedByName.get(serverName) ?? [];
        list.push(suite);
        detachedByName.set(serverName, list);
      }
    }

    const liveGroups = serverRows
      .map((s) => ({
        id: s.id,
        name: s.name,
        serverTitle: s.serverTitle,
        serverDescription: s.serverDescription,
        enabled: s.enabled,
        detached: false,
        suites: (suitesByServer.get(s.id) ?? []).sort((a, b) =>
          alphabeticCompare(a.name, b.name),
        ),
      }))
      .filter((g) => g.suites.length > 0);

    const detachedGroups = [...detachedByName.entries()].map(([serverName, suites]) => ({
      id: `detached:${serverName}`,
      name: serverName,
      serverTitle: serverName,
      serverDescription: null,
      enabled: true,
      detached: true,
      suites: suites.sort((a, b) => alphabeticCompare(a.name, b.name)),
    }));

    return [...liveGroups, ...detachedGroups].sort((a, b) =>
      alphabeticCompare(a.serverTitle || a.name, b.serverTitle || b.name),
    );
  }, [serverRows, suiteRows]);

  const [runningServerId, setRunningServerId] = useState<string | null>(null);
  const [runningSuiteId, setRunningSuiteId] = useState<string | null>(null);

  const [createSuiteOpen, setCreateSuiteOpen] = useState<boolean>(false);
  const [editingSuite, setEditingSuite] = useState<{ id: string; name: string; serverName?: string } | null>(null);
  const [deletingSuite, setDeletingSuite] = useState<VerificationSuiteRow | null>(null);
  const [deletingServer, setDeletingServer] = useState<ServerTreeGroup | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  const handleStartServerRun = async (serverId: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    setRunningServerId(serverId);
    try {
      const res = await fetch("/api/verification-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpServerId: serverId }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Triggered server run");
    } catch {
      toast.error("Failed to start server run");
    } finally {
      setRunningServerId(null);
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

  const handleToggleSuiteVisibility = async (suite: VerificationSuiteRow, e: React.MouseEvent): Promise<void> => {
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

  const handleSuiteSave = async (name: string): Promise<void> => {
    if (!editingSuite) return;
    try {
      await verificationActions.patch(editingSuite.id, { name });
      void mutateSuites();
      toast.success("Suite updated");
    } catch {
      toast.error("Failed to update suite");
    }
  };

  const handleSuiteDeleteConfirm = async (): Promise<void> => {
    if (!deletingSuite) return;
    setDeleting(true);
    try {
      await verificationActions.remove(deletingSuite.id);
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

  const handleDeleteServerConfirm = async (): Promise<void> => {
    if (!deletingServer) return;
    setDeleting(true);
    try {
      if (deletingServer.detached) {
        // Detached group: no MCP server row exists (the synthetic group id
        // must never hit the server-scoped DELETE endpoint). Delete owned
        // suites via the per-suite endpoints — per-suite RBAC applies, so
        // suites owned by others are skipped with a 403.
        let deleted = 0;
        let skipped = 0;
        for (const suite of deletingServer.suites) {
          try {
            await verificationActions.remove(suite.id);
            deleted++;
          } catch {
            skipped++;
          }
        }
        toast.success(
          skipped > 0
            ? `Deleted ${deleted} suite${deleted === 1 ? "" : "s"} (${skipped} skipped — owned by others)`
            : `Deleted ${deleted} suite${deleted === 1 ? "" : "s"}`,
        );
        void mutateServers();
        void mutateSuites();
        router.push("/verification");
        return;
      }
      const res = await fetch(`/api/verification-servers/${deletingServer.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { deleted, skipped } = (await res.json()) as {
        deleted: number;
        skipped: number;
      };
      toast.success(
        skipped > 0
          ? `Deleted ${deleted} suite${deleted === 1 ? "" : "s"} (${skipped} skipped — owned by others)`
          : `Deleted ${deleted} suite${deleted === 1 ? "" : "s"}`,
      );
      void mutateServers();
      void mutateSuites();
      router.push("/verification");
    } catch {
      toast.error("Failed to delete server verification data");
    } finally {
      setDeleting(false);
      setDeletingServer(null);
    }
  };

  const isTreeLoading = serverLoading || suiteLoading;
  const treeError = serverError || suiteError;

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
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
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
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={() => {
              void mutateServers();
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
              expandedServerIds[group.id] ??
              (activeSuiteId ? group.suites.some((s) => s.id === activeSuiteId) : false);
            return (
              <ServerGroupNode
                key={group.id}
                group={group}
                expanded={isExpanded}
                onToggleExpand={() => toggleServerExpand(group.id, isExpanded)}
                activeSuiteId={activeSuiteId}
                onSelectSuite={(suiteId) => router.push(`/verification/${suiteId}`)}
                onRunServer={handleStartServerRun}
                onRunSuite={handleStartSuiteRun}
                onToggleSuiteVisibility={handleToggleSuiteVisibility}
                onEditSuite={(suite) =>
                  setEditingSuite({
                    id: suite.id,
                    name: suite.name,
                    serverName: group.serverTitle || group.name,
                  })
                }
                onDeleteSuite={setDeletingSuite}
                onDeleteServer={setDeletingServer}
                runningServerId={runningServerId}
                runningSuiteId={runningSuiteId}
              />
            );
          }))}
        </div>
      </ScrollArea>
      {/* New Suite Dialog */}
      <VerificationSuiteDialog
        open={createSuiteOpen}
        onOpenChange={setCreateSuiteOpen}
        onCreated={(created) => {
          void mutateSuites();
          void mutateServers();
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
          serverName={editingSuite?.serverName ?? "MCP Server"}
          suite={editingSuite}
          onUpdated={handleSuiteSave}
        />
      )}

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
              className="bg-destructive hover:bg-destructive/90"
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

      {/* Delete Server Dialog */}
      <AlertDialog
        open={deletingServer !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) setDeletingServer(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Server Verification Data</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete the verification suites you own under{" "}
              <strong>{deletingServer?.serverTitle || deletingServer?.name}</strong>? Suites owned
              by others are kept. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteServerConfirm();
              }}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="confirm-delete-server-button"
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
