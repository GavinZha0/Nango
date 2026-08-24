"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { Play, Plus, ChevronDown, ChevronRight, Folder, Trash2, Loader2, AlertCircle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWebAutoStore, useWebAutoTree, WebAutoSuiteRow } from "@/store/web-auto-store";
import { cn } from "@/lib/utils";
import useSWR, { mutate } from "swr";
import { NewWebAutoSuiteDialog } from "@/components/main-panels/web-auto/NewWebAutoSuiteDialog";
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
import { toast } from "sonner";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("An error occurred while fetching the data.");
  return res.json();
};

export function WebAutoPanel() {
  const router = useRouter();
  const params = useParams();
  const activeSuiteId = params?.id as string | undefined;

  const { 
    expandedGroups, 
    toggleGroup,
    setSuites,
    setLoading,
    setError
  } = useWebAutoStore();
  
  const tree = useWebAutoTree();
  const [suiteDialogOpen, setSuiteDialogOpen] = useState(false);
  const [suiteToEdit, setSuiteToEdit] = useState<WebAutoSuiteRow | null>(null);
  const [suiteToDelete, setSuiteToDelete] = useState<{ id: string; name: string; isGroup: boolean } | null>(null);
  const [deletingSuite, setDeletingSuite] = useState(false);

  const { data, error, isLoading } = useSWR<WebAutoSuiteRow[]>(
    "/api/web-auto-suites",
    fetcher
  );
  useEffect(() => {
    setLoading(isLoading);
    if (error) setError(error.message || "Failed to load suites");
    if (data) setSuites(data);
  }, [data, error, isLoading, setSuites, setLoading, setError]);

  const handleRunSuite = async (suiteId: string) => {
    try {
      const res = await fetch("/api/web-auto-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to start suite run");
      }
      toast.success(`Running ${data.totalCount} cases in background`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 min-h-[37px]">
        <span className="text-sm font-medium px-1">Web Automation</span>
        <div className="flex items-center gap-1 pr-2">
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-6 w-6 text-muted-foreground"
            title="New Suite"
            aria-label="New Suite"
            onClick={() => setSuiteDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && (
          <div className="p-4 text-center text-sm text-muted-foreground flex justify-center items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading targets...
          </div>
        )}
        
        {error && (
          <div className="p-4 text-center text-sm text-destructive flex justify-center items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error.message || "Error loading targets"}
          </div>
        )}

        {!isLoading && !error && tree.length === 0 && (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No targets or suites found.
          </div>
        )}
        
        {tree.map((target) => {
          const isExpanded = expandedGroups[target.id];
          return (
            <div key={target.id} className="select-none">
              <div className="group flex items-center justify-between border-b border-border/40 px-3 py-2 transition-colors hover:bg-muted/30 text-sm">
                <div className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer" onClick={() => toggleGroup(target.id)}>
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <Folder className="h-3.5 w-3.5 text-blue-500/70 shrink-0" />
                  <span className="truncate font-medium hover:underline underline-offset-2">{target.name}</span>
                </div>
                
                <div className="flex shrink-0 items-center gap-2 ml-2">
                  <button
                    type="button"
                    title="Run all suites for this target"
                    className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-green-500 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </button>
                  <button
                    type="button"
                    title="Edit group"
                    className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-blue-500 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSuiteToEdit({ id: target.id, name: target.name, parentId: null } as WebAutoSuiteRow);
                      setSuiteDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title="Delete target" className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors shrink-0 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); setSuiteToDelete({ id: target.id, name: target.name, isGroup: true }); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              
              {isExpanded && (
                <div className="flex flex-col pb-1">
                  {target.suites.map(suite => {
                    const active = activeSuiteId === suite.id;
                    return (
                      <div 
                        key={suite.id}
                        className={cn(
                          "group flex cursor-pointer items-center justify-between pl-8 pr-3 py-1.5 text-sm transition-colors",
                          active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                        )}
                        onClick={() => router.push(`/web-auto/${suite.id}`)}
                      >
                        <span className="truncate">{suite.name}</span>
                        <div className="flex shrink-0 items-center gap-1.5 opacity-0 group-hover:opacity-100">
                          <button
                            type="button"
                            title="Run suite"
                            className="rounded p-0.5 text-muted-foreground/70 hover:text-green-500 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRunSuite(suite.id);
                            }}
                          >
                            <Play className="h-3 w-3 fill-current" />
                          </button>
                          <button
                            type="button"
                            title="Edit suite"
                            className="rounded p-0.5 text-muted-foreground/70 hover:text-blue-500 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSuiteToEdit(suite);
                              setSuiteDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button type="button" title="Delete suite" className="rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors" onClick={(e) => { e.stopPropagation(); setSuiteToDelete({ id: suite.id, name: suite.name, isGroup: false }); }}>
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {target.suites.length === 0 && (
                    <div className="pl-8 py-1.5 text-xs text-muted-foreground italic">
                      No suites.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      
      <NewWebAutoSuiteDialog 
        open={suiteDialogOpen} 
        onOpenChange={(open) => {
          setSuiteDialogOpen(open);
          if (!open) setSuiteToEdit(null);
        }}
        onCreated={(id) => router.push(`/web-auto/${id}`)}
        suiteToEdit={suiteToEdit}
      />
      <AlertDialog
        open={suiteToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deletingSuite) setSuiteToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {suiteToDelete?.isGroup ? "group" : "suite"}</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete {suiteToDelete?.isGroup ? "group" : "suite"} <strong>{suiteToDelete?.name}</strong>? 
              {suiteToDelete?.isGroup && " All nested suites and cases will be removed."} This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSuite}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (e) => {
                e.preventDefault();
                if (!suiteToDelete) return;
                setDeletingSuite(true);
                try {
                  const res = await fetch(`/api/web-auto-suites/${suiteToDelete.id}`, { method: "DELETE" });
                  if (!res.ok) throw new Error("Failed to delete " + (suiteToDelete.isGroup ? "group" : "suite"));
                  await mutate("/api/web-auto-suites");
                  toast.success(`${suiteToDelete.isGroup ? "Group" : "Suite"} deleted`);
                  if (activeSuiteId === suiteToDelete.id) {
                    router.push("/web-auto");
                  }
                  setSuiteToDelete(null);
                } catch (err: unknown) {
                  toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                  setDeletingSuite(false);
                }
              }}
              disabled={deletingSuite}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deletingSuite ? (
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
