"use client";

import { useState, useMemo, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Folder,
  SquarePlus,
  ChevronRight,
  ChevronDown,
  Play,
  Pencil,
  Trash2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { cn } from "@/lib/utils";
import { alphabeticCompare } from "@/lib/utils/sort";
import { toast } from "sonner";
import {
  type WebAutoSuiteRow,
  type WebAutoTarget,
} from "@/store/web-auto-store";
import { NewWebAutoSuiteDialog } from "@/components/main-panels/web-auto/NewWebAutoSuiteDialog";
import { WebAutoSuiteEditDialog } from "@/components/main-panels/web-auto/WebAutoSuiteEditDialog";

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Failed to load suites");
    return res.json();
  });

interface SuiteRowItemProps {
  suite: WebAutoSuiteRow;
  active: boolean;
  onSelect: () => void;
  onRunSuite: (e: React.MouseEvent) => void;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}

function SuiteRowItem({
  suite,
  active,
  onSelect,
  onRunSuite,
  onEdit,
  onDelete,
}: SuiteRowItemProps): ReactNode {
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
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          disabled={!suite.mcpServerId || !suite.enabled}
          title={!suite.mcpServerId ? "Playwright not configured" : "Run"}
          className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-green-500 transition-colors shrink-0 disabled:opacity-40 disabled:hover:text-muted-foreground/70"
          onClick={onRunSuite}
        >
          <Play className="h-3 w-3 fill-current" />
        </button>
        <button
          type="button"
          title="Edit"
          className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-blue-500 transition-colors shrink-0"
          onClick={onEdit}
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          title="Delete"
          className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors shrink-0"
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

interface TargetGroupNodeProps {
  target: WebAutoTarget;
  expanded: boolean;
  onToggleExpand: () => void;
  activeSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onRunTarget: (e: React.MouseEvent) => void;
  onRunSuite: (suiteId: string, e: React.MouseEvent) => void;
  onAddSuite: (targetId: string, e: React.MouseEvent) => void;
  onEditTarget: (target: WebAutoTarget, e: React.MouseEvent) => void;
  onEditSuite: (suite: WebAutoSuiteRow, e: React.MouseEvent) => void;
  onDeleteTarget: (target: WebAutoTarget, e: React.MouseEvent) => void;
  onDeleteSuite: (suite: WebAutoSuiteRow, e: React.MouseEvent) => void;
}

function TargetGroupNode({
  target,
  expanded,
  onToggleExpand,
  activeSuiteId,
  onSelectSuite,
  onRunTarget,
  onRunSuite,
  onAddSuite,
  onEditTarget,
  onEditSuite,
  onDeleteTarget,
  onDeleteSuite,
}: TargetGroupNodeProps): ReactNode {
  const runnableSuites = target.suites.filter((s) => s.mcpServerId && s.enabled);
  const isTargetRunnable = runnableSuites.length > 0;

  return (
    <div className="select-none border-b border-border/40 last:border-0">
      {/* Level 1: Target Folder */}
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
          <Folder className="h-3.5 w-3.5 text-blue-500/70 shrink-0" />
          <span className="truncate font-medium hover:underline underline-offset-2">
            {target.name}
          </span>
          {target.suites.length > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.2 text-[9px] text-muted-foreground">
              {target.suites.length}
            </span>
          )}
        </div>

        {/* Level 1 Actions */}
        <div className="flex shrink-0 items-center gap-1 ml-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            disabled={!isTargetRunnable}
            title={
              target.suites.length === 0
                ? "No suites to run"
                : !isTargetRunnable
                ? "Playwright not configured"
                : "Run all suites for this target"
            }
            className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-green-500 transition-colors shrink-0 disabled:opacity-40 disabled:hover:text-muted-foreground/70"
            onClick={onRunTarget}
          >
            <Play className="h-3.5 w-3.5 fill-current" />
          </button>
          <button
            type="button"
            title="Add suite under target"
            className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors shrink-0"
            onClick={(e) => onAddSuite(target.id, e)}
          >
            <SquarePlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Edit target"
            className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-blue-500 transition-colors shrink-0"
            onClick={(e) => onEditTarget(target, e)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Delete target"
            className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors shrink-0"
            onClick={(e) => onDeleteTarget(target, e)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Level 2: Suites List */}
      {expanded && (
        <div className="flex flex-col pb-1">
          {target.suites.length === 0 ? (
            <div className="pl-7 py-1 text-[11px] text-muted-foreground italic">
              No suites.
            </div>
          ) : (
            target.suites.map((suite) => (
              <SuiteRowItem
                key={suite.id}
                suite={suite}
                active={activeSuiteId === suite.id}
                onSelect={() => onSelectSuite(suite.id)}
                onRunSuite={(e) => {
                  e.stopPropagation();
                  onRunSuite(suite.id, e);
                }}
                onEdit={(e) => {
                  e.stopPropagation();
                  onEditSuite(suite, e);
                }}
                onDelete={(e) => {
                  e.stopPropagation();
                  onDeleteSuite(suite, e);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function WebAutoPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const activeSuiteId = pathname.startsWith("/web-auto/")
    ? pathname.split("/")[2]
    : null;

  const [expandedTargetIds, setExpandedTargetIds] = useState<Record<string, boolean>>({});

  // Dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState<boolean>(false);
  const [createDefaultTargetId, setCreateDefaultTargetId] = useState<string | null>(null);
  const [editingSuite, setEditingSuite] = useState<WebAutoSuiteRow | null>(null);
  const [deletingItem, setDeletingItem] = useState<{
    id: string;
    name: string;
    isTarget: boolean;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const {
    data: suites = [],
    error,
    isLoading,
    mutate,
  } = useSWR<WebAutoSuiteRow[]>("/api/web-auto-suites", fetcher);

  const { data: mcpServers = [] } = useSWR<
    Array<{ id: string; name: string; enabled?: boolean }>
  >("/api/mcp-servers", fetcher);

  const defaultPlaywrightServer = useMemo(() => {
    if (!mcpServers || mcpServers.length === 0) return null;
    const exactMatch = mcpServers.find(
      (s) =>
        s.name.toLowerCase() === "playwright" ||
        s.name.toLowerCase() === "playwright-mcp",
    );
    if (exactMatch) return exactMatch;
    return (
      mcpServers.find((s) => s.name.toLowerCase().includes("playwright")) ??
      mcpServers[0] ??
      null
    );
  }, [mcpServers]);

  const tree = useMemo<WebAutoTarget[]>(() => {
    const targets: WebAutoTarget[] = [];
    const targetMap = new Map<string, WebAutoTarget>();

    suites.forEach((suite) => {
      if (!suite.parentId) {
        const target: WebAutoTarget = {
          id: suite.id,
          name: suite.name,
          suites: [],
        };
        targets.push(target);
        targetMap.set(suite.id, target);
      }
    });

    suites.forEach((suite) => {
      if (suite.parentId && targetMap.has(suite.parentId)) {
        targetMap.get(suite.parentId)!.suites.push(suite);
      }
    });

    // Sort suites in each target alphabetically, filter out empty targets, and sort targets
    return targets
      .map((t) => ({
        ...t,
        suites: t.suites.sort((a, b) => alphabeticCompare(a.name, b.name)),
      }))
      .filter((t) => t.suites.length > 0)
      .sort((a, b) => alphabeticCompare(a.name, b.name));
  }, [suites]);

  const toggleTarget = (targetId: string, currentlyExpanded: boolean) => {
    setExpandedTargetIds((prev) => ({
      ...prev,
      [targetId]: !currentlyExpanded,
    }));
  };

  const handleRunSuite = async (suiteId: string) => {
    try {
      const res = await fetch("/api/web-auto-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId }),
      });
      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.message || "Failed to start suite run");
      }
      toast.success(`Running ${resData.totalCount} cases in background`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunTarget = async (target: WebAutoTarget, e: React.MouseEvent) => {
    e.stopPropagation();
    if (target.suites.length === 0) {
      toast.info("No suites to run for this target");
      return;
    }
    try {
      await Promise.all(
        target.suites.map((s) =>
          fetch("/api/web-auto-runs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ suiteId: s.id }),
          }),
        ),
      );
      toast.success(
        `Triggered runs for all ${target.suites.length} suites in ${target.name}`,
      );
    } catch {
      toast.error("Failed to run all suites");
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingItem) return;
    setIsDeleting(true);
    try {
      const isDeletingChildSuite = !deletingItem.isTarget;
      const parentTarget = isDeletingChildSuite
        ? tree.find((t) => t.suites.some((s) => s.id === deletingItem.id))
        : null;

      const res = await fetch(`/api/web-auto-suites/${deletingItem.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete");

      // If deleting the last child suite under a target, cascade-delete the parent target
      if (parentTarget && parentTarget.suites.length <= 1) {
        await fetch(`/api/web-auto-suites/${parentTarget.id}`, {
          method: "DELETE",
        }).catch(() => {
          // ignore error if already cleaned up
        });
      }

      toast.success("Deleted successfully");
      void mutate();
      if (activeSuiteId === deletingItem.id) {
        router.push("/web-auto");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeleting(false);
      setDeletingItem(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header toolbar */}
      <div className="flex items-stretch justify-between border-b bg-muted/40 pr-1.5">
        <span className="flex items-center px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Web Automation
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            title="New suite"
            aria-label="New suite"
            onClick={() => {
              setCreateDefaultTargetId(null);
              setCreateDialogOpen(true);
            }}
          >
            <SquarePlus className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground"
            onClick={() => {
              void mutate();
            }}
            disabled={isLoading}
            aria-label="Refresh list"
            title="Refresh list"
          >
            <RefreshCw
              className={cn("h-3 w-3", isLoading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {/* Main tree list */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          {isLoading && tree.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground flex justify-center items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading targets…
            </div>
          )}

          {error && (
            <p className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {error.message || "Failed to load suites"}
            </p>
          )}

          {!isLoading && !error && tree.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No web automation targets or suites found.
            </div>
          )}

          {tree.map((target) => {
            const isExpanded =
              expandedTargetIds[target.id] ??
              (activeSuiteId ? target.suites.some((s) => s.id === activeSuiteId) : false);
            return (
              <TargetGroupNode
                key={target.id}
                target={target}
                expanded={isExpanded}
                onToggleExpand={() => toggleTarget(target.id, isExpanded)}
                activeSuiteId={activeSuiteId}
                onSelectSuite={(suiteId) => router.push(`/web-auto/${suiteId}`)}
                onRunTarget={(e) => void handleRunTarget(target, e)}
                onRunSuite={(suiteId) => void handleRunSuite(suiteId)}
                onAddSuite={(targetId, e) => {
                  e.stopPropagation();
                  setCreateDefaultTargetId(targetId);
                  setCreateDialogOpen(true);
                }}
                onEditTarget={(tgt, e) => {
                  e.stopPropagation();
                  setEditingSuite({
                    id: tgt.id,
                    name: tgt.name,
                    parentId: null,
                  } as WebAutoSuiteRow);
                }}
                onEditSuite={(suite) => setEditingSuite(suite)}
                onDeleteTarget={(tgt, e) => {
                  e.stopPropagation();
                  setDeletingItem({ id: tgt.id, name: tgt.name, isTarget: true });
                }}
                onDeleteSuite={(suite) => {
                  setDeletingItem({ id: suite.id, name: suite.name, isTarget: false });
                }}
              />
            );
          })}
        </div>
      </ScrollArea>

      {/* New Suite Dialog */}
      <NewWebAutoSuiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        targets={tree}
        defaultTargetId={createDefaultTargetId}
        defaultMcpServerId={defaultPlaywrightServer?.id || null}
        onCreated={(created) => {
          void mutate();
          router.push(`/web-auto/${created.id}`);
        }}
      />

      {/* Edit Suite Dialog */}
      <WebAutoSuiteEditDialog
        open={editingSuite !== null}
        onOpenChange={(open) => {
          if (!open) setEditingSuite(null);
        }}
        suite={editingSuite}
        onSaved={() => void mutate()}
      />

      {/* Delete Confirmation */}
      <DeleteConfirmDialog
        open={deletingItem !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeletingItem(null);
        }}
        title={`Delete ${deletingItem?.isTarget ? "Target" : "Suite"}`}
        description={
          deletingItem?.isTarget ? (
            <>
              Permanently delete target <strong>{deletingItem.name}</strong>?
              All suites and test cases inside this target will be removed.
            </>
          ) : (
            <>
              Permanently delete suite <strong>{deletingItem?.name}</strong>?
              All test cases and recorded results will be removed.
            </>
          )
        }
        onConfirm={handleDeleteConfirm}
        deleting={isDeleting}
      />
    </div>
  );
}
