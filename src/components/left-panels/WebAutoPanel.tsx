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
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogFooter 
} from "@/components/ui/dialog";
import { 
  AlertDialog, 
  AlertDialogAction, 
  AlertDialogCancel, 
  AlertDialogContent, 
  AlertDialogDescription, 
  AlertDialogFooter, 
  AlertDialogHeader, 
  AlertDialogTitle 
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { 
  type WebAutoSuiteRow, 
  type WebAutoTarget 
} from "@/store/web-auto-store";

const fetcher = (url: string) => fetch(url).then((res) => {
  if (!res.ok) throw new Error("Failed to load suites");
  return res.json();
});

export function WebAutoPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const activeSuiteId = pathname.startsWith("/web-auto/") ? pathname.split("/")[2] : null;

  const [expandedTargetIds, setExpandedTargetIds] = useState<Record<string, boolean>>({});

  // Dialog states
  const [suiteDialogOpen, setSuiteDialogOpen] = useState<boolean>(false);
  const [suiteToEdit, setSuiteToEdit] = useState<WebAutoSuiteRow | null>(null);
  const [suiteToDelete, setSuiteToDelete] = useState<{ id: string; name: string; isTarget: boolean } | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Form states
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [newTargetName, setNewTargetName] = useState<string>("");
  const [formSuiteName, setFormSuiteName] = useState<string>("");
  const [formDescription, setFormDescription] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const { data: suites = [], error, isLoading, mutate } = useSWR<WebAutoSuiteRow[]>(
    "/api/web-auto-suites",
    fetcher
  );

  const { data: mcpServers = [] } = useSWR<Array<{ id: string; name: string; enabled?: boolean }>>(
    "/api/mcp-servers",
    fetcher
  );

  const defaultPlaywrightServer = useMemo(() => {
    if (!mcpServers || mcpServers.length === 0) return null;
    const exactMatch = mcpServers.find(
      (s) =>
        s.name.toLowerCase() === "playwright" ||
        s.name.toLowerCase() === "playwright-mcp",
    );
    if (exactMatch) return exactMatch;
    return mcpServers.find((s) => s.name.toLowerCase().includes("playwright")) ?? mcpServers[0] ?? null;
  }, [mcpServers]);

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
          })
        )
      );
      toast.success(`Triggered runs for all ${target.suites.length} suites in ${target.name}`);
    } catch {
      toast.error("Failed to run all suites");
    }
  };

  // Build tree from flat suites list (Pass 1: Targets with parentId=null; Pass 2: Suites under Target)
  const tree = useMemo(() => {
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

    return targets;
  }, [suites]);

  const toggleTarget = (targetId: string) => {
    setExpandedTargetIds((prev) => ({
      ...prev,
      [targetId]: !(prev[targetId] ?? true),
    }));
  };

  const openCreateDialog = (defaultTargetId: string | null = null) => {
    setSuiteToEdit(null);
    setFormSuiteName("");
    setFormDescription("");
    setNewTargetName("");
    if (defaultTargetId) {
      setSelectedTargetId(defaultTargetId);
    } else if (tree.length > 0) {
      setSelectedTargetId(tree[0].id);
    } else {
      setSelectedTargetId("NEW_TARGET");
    }
    setSuiteDialogOpen(true);
  };

  const openEditDialog = (suite: WebAutoSuiteRow, e: React.MouseEvent) => {
    e.stopPropagation();
    setSuiteToEdit(suite);
    setFormSuiteName(suite.name);
    setFormDescription(suite.description || "");
    setSelectedTargetId(suite.parentId || "");
    setNewTargetName("");
    setSuiteDialogOpen(true);
  };

  const handleSaveSuite = async () => {
    if (suiteToEdit) {
      if (!formSuiteName.trim()) {
        toast.error("Name is required");
        return;
      }
      setIsSubmitting(true);
      try {
        const res = await fetch(`/api/web-auto-suites/${suiteToEdit.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formSuiteName.trim(),
            description: formDescription.trim() || null,
          }),
        });
        if (!res.ok) throw new Error("Failed to update");
        toast.success("Updated successfully");
        void mutate();
        setSuiteDialogOpen(false);
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // Creating a new suite
    const isCreatingNewTarget = selectedTargetId === "NEW_TARGET" || tree.length === 0;
    if (isCreatingNewTarget && !newTargetName.trim()) {
      toast.error("Target name is required");
      return;
    }
    if (!formSuiteName.trim()) {
      toast.error("Suite name is required");
      return;
    }

    setIsSubmitting(true);
    try {
      let targetId = selectedTargetId;
      if (isCreatingNewTarget) {
        const targetRes = await fetch("/api/web-auto-suites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newTargetName.trim(),
            parentId: null,
          }),
        });
        if (!targetRes.ok) throw new Error("Failed to create target");
        const createdTarget = await targetRes.json();
        targetId = createdTarget.id;
      }

      const suiteRes = await fetch("/api/web-auto-suites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formSuiteName.trim(),
          description: formDescription.trim() || null,
          parentId: targetId,
          mcpServerId: defaultPlaywrightServer?.id || null,
        }),
      });
      if (!suiteRes.ok) throw new Error("Failed to create automation suite");
      const createdSuite = await suiteRes.json();
      toast.success("Automation suite created");
      void mutate();
      setSuiteDialogOpen(false);
      router.push(`/web-auto/${createdSuite.id}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!suiteToDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/web-auto-suites/${suiteToDelete.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete");
      toast.success("Deleted successfully");
      void mutate();
      if (activeSuiteId === suiteToDelete.id) {
        router.push("/web-auto");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
      setSuiteToDelete(null);
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
            onClick={() => openCreateDialog(null)}
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
            const isExpanded = expandedTargetIds[target.id] ?? true;
            return (
              <div key={target.id} className="select-none border-b border-border/40 last:border-0">
                {/* Level 1: Target */}
                <div 
                  className="group flex items-center justify-between px-2.5 py-1.5 transition-colors hover:bg-muted/30 text-xs cursor-pointer"
                  onClick={() => toggleTarget(target.id)}
                >
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    {isExpanded ? (
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
                    {(() => {
                      const runnableSuites = target.suites.filter((s) => s.mcpServerId && s.enabled);
                      const isTargetRunnable = runnableSuites.length > 0;
                      return (
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
                          onClick={(e) => void handleRunTarget(target, e)}
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      title="Add suite under target"
                      className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        openCreateDialog(target.id);
                      }}
                    >
                      <SquarePlus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Edit target"
                      className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-blue-500 transition-colors shrink-0"
                      onClick={(e) => openEditDialog({ id: target.id, name: target.name, parentId: null } as WebAutoSuiteRow, e)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button 
                      type="button" 
                      title="Delete target" 
                      className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors shrink-0" 
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        setSuiteToDelete({ id: target.id, name: target.name, isTarget: true }); 
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                
                {/* Level 2: Suites */}
                {isExpanded && (
                  <div className="flex flex-col pb-1">
                    {target.suites.map((suite) => {
                      const active = activeSuiteId === suite.id;
                      return (
                        <div 
                          key={suite.id}
                          className={cn(
                            "group flex cursor-pointer items-center justify-between pl-7 pr-2 py-1.5 text-xs transition-colors rounded select-none",
                            active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                            !suite.enabled && "opacity-50"
                          )}
                          onClick={() => router.push(`/web-auto/${suite.id}`)}
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
                              title={
                                !suite.mcpServerId
                                  ? "Playwright not configured"
                                  : "Run"
                              }
                              className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-green-500 transition-colors shrink-0 disabled:opacity-40 disabled:hover:text-muted-foreground/70"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleRunSuite(suite.id);
                              }}
                            >
                              <Play className="h-3 w-3 fill-current" />
                            </button>
                            <button
                              type="button"
                              title="Edit"
                              className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-blue-500 transition-colors shrink-0"
                              onClick={(e) => openEditDialog(suite, e)}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button 
                              type="button" 
                              title="Delete" 
                              className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-destructive transition-colors shrink-0" 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                setSuiteToDelete({ id: suite.id, name: suite.name, isTarget: false }); 
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {target.suites.length === 0 && (
                      <div className="pl-7 py-1 text-[11px] text-muted-foreground italic">
                        No suites.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Create / Edit Suite Dialog (2-level: Target -> Suite Name -> Description) */}
      <Dialog open={suiteDialogOpen} onOpenChange={setSuiteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {suiteToEdit
                ? suiteToEdit.parentId === null
                  ? "Edit Target"
                  : "Edit Suite"
                : "New Suite"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {!suiteToEdit && (
              <>
                {/* 1. Target Selector */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="target-select">Target <span className="text-destructive">*</span></Label>
                  <Select
                    required
                    value={selectedTargetId}
                    onValueChange={(val) => setSelectedTargetId(val ?? "")}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger id="target-select" className="w-full">
                      <SelectValue placeholder="Select target">
                        {selectedTargetId === "NEW_TARGET" ? (
                          <span className="text-primary font-semibold">+ Create new target...</span>
                        ) : selectedTargetId ? (
                          tree.find((t) => t.id === selectedTargetId)?.name || "Select target"
                        ) : null}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {tree.map((t) => (
                        <SelectItem key={t.id} value={t.id} label={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}
                      <SelectItem value="NEW_TARGET" label="+ Create new target..." className="text-primary font-semibold">
                        + Create new target...
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Optional: New Target Name Input */}
                {(selectedTargetId === "NEW_TARGET" || tree.length === 0) && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-target-name">
                      Target Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      required
                      id="new-target-name"
                      value={newTargetName}
                      onChange={(e) => setNewTargetName(e.target.value)}
                      disabled={isSubmitting}
                      autoFocus
                    />
                  </div>
                )}
              </>
            )}

            {/* 2. Suite Name */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="suite-name">
                {suiteToEdit && suiteToEdit.parentId === null ? "Target Name" : "Suite Name"}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <Input
                required
                id="suite-name"
                value={formSuiteName}
                onChange={(e) => setFormSuiteName(e.target.value)}
                disabled={isSubmitting}
                autoFocus={!suiteToEdit && selectedTargetId !== "NEW_TARGET"}
              />
            </div>

            {/* 3. Description (3 rows fixed) */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Brief description of this suite's test scope"
                rows={3}
                className="resize-none"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSuiteDialogOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleSaveSuite()}
              disabled={
                isSubmitting ||
                !formSuiteName.trim() ||
                (!suiteToEdit && (selectedTargetId === "NEW_TARGET" || tree.length === 0) && !newTargetName.trim())
              }
            >
              {isSubmitting ? (
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

      {/* Delete Confirmation Alert Dialog */}
      <AlertDialog open={suiteToDelete !== null} onOpenChange={(open) => !open && !deleting && setSuiteToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {suiteToDelete?.isTarget ? "Target" : "Suite"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{suiteToDelete?.name}</strong>?
              {suiteToDelete?.isTarget
                ? " All suites and test cases inside this target will be permanently removed."
                : " All test cases and run history will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
