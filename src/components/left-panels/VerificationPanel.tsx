"use client";

import { useEffect, useState, useMemo, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  RefreshCw,
  Play,
  Trash2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

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
import {
  useVerificationStore,
  verificationActions,
  type VerificationCategory,
  type VerificationServerRow,
} from "@/store/verification";
import { NewCaseDialog } from "@/components/main-panels/verification/NewCaseDialog";

const CATEGORIES: ReadonlyArray<{ id: VerificationCategory; label: string }> = [
  { id: "mcp", label: "MCP" },
  { id: "workflow", label: "Workflow" },
];

interface ServerRowProps {
  row: VerificationServerRow;
  active: boolean;
  onSelect: () => void;
  onStartRun: (e: React.MouseEvent) => void;
  onDeleteRequest: (e: React.MouseEvent) => void;
  running: boolean;
}

function ServerRow({
  row,
  active,
  onSelect,
  onStartRun,
  onDeleteRequest,
  running,
}: ServerRowProps): ReactNode {

  const displayName = row.serverTitle || row.name;
  return (
    <div
      className={cn(
        "group flex items-center justify-between border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 cursor-pointer" onClick={onSelect}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="truncate text-left text-sm font-medium hover:underline underline-offset-2"
          >
            {displayName}
          </span>
          {row.caseCount > 0 && (
            <span
              className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
              title={`${row.caseCount} tool${row.caseCount === 1 ? "" : "s"}`}
            >
              {row.caseCount}
            </span>
          )}
        </div>
        {row.serverDescription && (
          <p className="truncate text-xs text-muted-foreground">
            {row.serverDescription}
          </p>
        )}
      </div>

      {/* ── Right cluster: run + delete (always visible) ── */}
      <div className="flex shrink-0 items-center gap-2 ml-2">
        {/* Start Run */}
        <button
          type="button"
          onClick={onStartRun}
          disabled={running || !row.enabled}
          title={!row.enabled ? "Server disabled" : "Run all cases"}
          aria-label="Run server regression"
          className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-green-500 disabled:opacity-50 transition-colors shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
        </button>

        {/* 3. Delete Request */}
        <button
          type="button"
          onClick={onDeleteRequest}
          title="Delete server & cases"
          aria-label="Delete verification data"
          className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-destructive disabled:opacity-50 transition-colors shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

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

export function VerificationPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  const category = useVerificationStore((s) => s.category);
  const mcpItems = useVerificationStore((s) => s.items.mcp) as unknown as VerificationServerRow[];
  const sortedItems = useMemo(() => {
    const list = category === "mcp" ? mcpItems : [];
    return [...list].sort((a, b) =>
      alphabeticCompare(a.serverTitle || a.name, b.serverTitle || b.name)
    );
  }, [mcpItems, category]);
  const loadedForCategory = useVerificationStore(
    (s) => s.loaded[s.category],
  );
  const loading = useVerificationStore((s) => s.loading);
  const error = useVerificationStore((s) => s.error);

  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const [runningServerId, setRunningServerId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VerificationServerRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Active server id is derived from /verification/server/<id>
  const match = pathname.match(/^\/verification\/server\/([^/]+)/);
  const activeServerId = match ? match[1] : null;

  useEffect(() => {
    if (!loadedForCategory) void verificationActions.refresh(category);
  }, [category, loadedForCategory]);

  const setCategory = (c: VerificationCategory): void => {
    useVerificationStore.getState().setCategory(c);
  };

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
      toast.success("Triggered server regression run");
    } catch {
      toast.error("Failed to start regression run");
    } finally {
      setRunningServerId(null);
    }
  };

  const handleDeleteServerVerification = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/verification-servers/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Deleted all server verification suites and cases");
      
      // Refresh left panel
      void verificationActions.refresh("mcp");
      
      // If currently inside the deleted server view, redirect to welcome page
      if (pathname.includes(`/verification/server/${deleteTarget.id}`)) {
        router.push("/verification");
      }
    } catch {
      toast.error("Failed to delete server verification data");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
        {CATEGORIES.map((c) => (
          <TabButton
            key={c.id}
            label={c.label}
            count={c.id === "mcp" ? mcpItems.length : 0}
            active={category === c.id}
            onClick={() => setCategory(c.id)}
          />
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void verificationActions.refresh(category)}
            disabled={loading}
            aria-label="Refresh servers"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          {error && (
            <p className="mx-3 my-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          )}
          {category === "workflow" ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">
              Workflow verification is coming in a later release.
            </p>
          ) : !loadedForCategory && loading ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">Loading…</p>
          ) : sortedItems.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No verification case yet.{" "}
              <button
                type="button"
                className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                onClick={() => setNewCaseOpen(true)}
              >
                Create one
              </button>
            </div>
          ) : (
            sortedItems.map((row) => (
              <ServerRow
                key={row.id}
                row={row}
                active={row.id === activeServerId}
                onSelect={() => router.push(`/verification/server/${row.id}`)}
                onStartRun={(e) => void handleStartServerRun(row.id, e)}
                onDeleteRequest={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(row);
                }}
                running={runningServerId === row.id}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <NewCaseDialog
        open={newCaseOpen}
        onOpenChange={setNewCaseOpen}
        onCreated={(created) => {
          if (created.mcpServerId) {
            router.push(`/verification/server/${created.mcpServerId}`);
          }
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Server Verification Data</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete all verification tools and test cases under{" "}
              <strong>{deleteTarget?.serverTitle || deleteTarget?.name}</strong>? This
              will erase all assertions and historic test results. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteServerVerification();
              }}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90"
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
