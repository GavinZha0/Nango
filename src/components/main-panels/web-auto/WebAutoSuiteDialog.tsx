"use client";

import { useState, useMemo, useRef, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SuiteVariablesEditor,
  type SuiteVariablesEditorRef,
} from "@/components/common/SuiteVariablesEditor";
import type { SuiteVariablesMap } from "@/lib/testing/types";
import type { WebAutoSuiteRow, WebAutoTarget } from "@/store/web-auto-store";
import { useWorkspaceStore } from "@/store/workspace";
import { findBestPlaywrightMcpServer } from "@/lib/web-auto/matching";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface WebAutoSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suite?: WebAutoSuiteRow | null;
  targets?: WebAutoTarget[];
  defaultTargetId?: string | null;
  defaultMcpServerId?: string | null;
  onCreated?: (created: WebAutoSuiteRow) => void;
  onSaved?: () => void;
}

export function WebAutoSuiteDialog({
  open,
  onOpenChange,
  suite,
  targets = [],
  defaultTargetId = null,
  defaultMcpServerId = null,
  onCreated,
  onSaved,
}: WebAutoSuiteDialogProps): ReactNode {
  const isEdit = !!suite;
  const isTarget = isEdit && suite?.parentId === null;

  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const evaluators = useMemo(
    () => builtinAgents.filter((a) => a.role === "evaluator"),
    [builtinAgents],
  );

  const { data: mcpServers = [] } = useSWR<
    Array<{ id: string; name: string; enabled?: boolean; visibility?: string }>
  >("/api/mcp-servers", fetcher);

  const autoMatchedPlaywrightServer = useMemo(() => {
    return findBestPlaywrightMcpServer(mcpServers);
  }, [mcpServers]);

  const [activeTab, setActiveTab] = useState<string>("general");
  const [name, setName] = useState<string>(suite?.name ?? "");
  const [description, setDescription] = useState<string>(suite?.description ?? "");
  const [variables, setVariables] = useState<SuiteVariablesMap>(
    (suite?.variables as SuiteVariablesMap) ?? {},
  );
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [newTargetName, setNewTargetName] = useState<string>("");
  const [selectedEvalId, setSelectedEvalId] = useState<string>(
    suite?.evaluatorAgentId ?? "",
  );
  const [userSelectedMcpId, setUserSelectedMcpId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const variablesEditorRef = useRef<SuiteVariablesEditorRef>(null);

  const effectiveMcpId =
    userSelectedMcpId !== null
      ? userSelectedMcpId
      : (suite?.mcpServerId ?? defaultMcpServerId ?? autoMatchedPlaywrightServer?.id ?? "");

  const [lastOpen, setLastOpen] = useState<boolean>(open);
  const [lastSuiteId, setLastSuiteId] = useState<string | null>(suite?.id ?? null);

  if (open !== lastOpen || (suite?.id ?? null) !== lastSuiteId) {
    setLastOpen(open);
    setLastSuiteId(suite?.id ?? null);
    if (open) {
      setActiveTab("general");
      setName(suite?.name ?? "");
      setDescription(suite?.description ?? "");
      setVariables((suite?.variables as SuiteVariablesMap) ?? {});
      setNewTargetName("");
      setSelectedEvalId(suite?.evaluatorAgentId ?? "");
      setUserSelectedMcpId(suite?.mcpServerId ?? null);
      if (defaultTargetId) {
        setSelectedTargetId(defaultTargetId);
      } else if (targets.length > 0) {
        setSelectedTargetId(targets[0].id);
      } else {
        setSelectedTargetId("NEW_TARGET");
      }
    }
  }

  const isCreatingNewTarget = !isEdit && (selectedTargetId === "NEW_TARGET" || targets.length === 0);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(isTarget ? "Target name is required" : "Suite name is required");
      return;
    }

    if (isEdit && suite) {
      setIsSubmitting(true);
      try {
        const res = await fetch(`/api/web-auto-suites/${suite.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || null,
            evaluatorAgentId: !isTarget && selectedEvalId ? selectedEvalId : null,
            mcpServerId: !isTarget && effectiveMcpId ? effectiveMcpId : null,
            ...(!isTarget ? { variables } : {}),
          }),
        });
        if (!res.ok) throw new Error("Failed to update");
        toast.success("Updated successfully");
        onOpenChange(false);
        onSaved?.();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (isCreatingNewTarget && !newTargetName.trim()) {
      toast.error("Target name is required");
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
        const createdTarget = (await targetRes.json()) as WebAutoSuiteRow;
        targetId = createdTarget.id;
      }

      const suiteRes = await fetch("/api/web-auto-suites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          parentId: targetId,
          mcpServerId: effectiveMcpId ? effectiveMcpId : null,
          evaluatorAgentId: selectedEvalId ? selectedEvalId : null,
          variables,
        }),
      });
      if (!suiteRes.ok) throw new Error("Failed to create automation suite");
      const createdSuite = (await suiteRes.json()) as WebAutoSuiteRow;
      toast.success("Automation suite created");
      onOpenChange(false);
      onCreated?.(createdSuite);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const title = isEdit ? (isTarget ? "Edit Target" : "Edit Suite") : "New Suite";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isTarget ? "sm:max-w-md" : "sm:max-w-xl h-[600px] max-h-[85vh] flex flex-col"}>
        {isTarget ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="target-name">
                  Target Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  required
                  id="target-name"
                  data-testid="web-auto-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isSubmitting}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="target-desc">Description</Label>
                <Textarea
                  id="target-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of this target group"
                  rows={3}
                  className="resize-none"
                  disabled={isSubmitting}
                />
              </div>
            </div>
          </>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <DialogHeader className="flex flex-row items-center justify-between border-b pb-3 pr-8 shrink-0">
              <div className="flex items-center gap-3">
                <DialogTitle className="text-base font-semibold leading-none">{title}</DialogTitle>
                <TabsList className="h-7 p-0.5">
                  <TabsTrigger value="general" className="text-xs px-2.5 py-1">General</TabsTrigger>
                  <TabsTrigger value="variables" className="text-xs px-2.5 py-1">
                    Variables
                    {Object.keys(variables).length > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary/20 text-primary px-1.5 py-0.2 text-[10px] font-mono">
                        {Object.keys(variables).length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>

              {activeTab === "variables" && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => variablesEditorRef.current?.addVariable()}
                          disabled={isSubmitting}
                          className="h-7 w-7 text-xs shrink-0 cursor-pointer"
                          data-testid="add-suite-variable-button"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span className="sr-only">Add Variable</span>
                        </Button>
                      }
                    />
                    <TooltipContent side="bottom" className="text-xs">
                      Add Variable
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </DialogHeader>

            <div className="flex-1 overflow-y-auto pr-1 mt-3">
              <TabsContent value="general" className="mt-0 space-y-4 py-1">
                {/* Target Selector (Only in New Mode) */}
                {!isEdit && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="target-select">
                      Target <span className="text-destructive">*</span>
                    </Label>
                    <Select
                      required
                      value={selectedTargetId}
                      onValueChange={(val) => setSelectedTargetId(val ?? "")}
                      disabled={isSubmitting}
                    >
                      <SelectTrigger id="target-select" data-testid="web-auto-target-select" className="w-full">
                        <SelectValue placeholder="Select target">
                          {selectedTargetId === "NEW_TARGET" ? (
                            <span className="text-primary font-semibold">
                              + Create new target...
                            </span>
                          ) : selectedTargetId ? (
                            targets.find((t) => t.id === selectedTargetId)?.name ||
                            "Select target"
                          ) : null}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {targets.map((t) => (
                          <SelectItem key={t.id} value={t.id} label={t.name}>
                            {t.name}
                          </SelectItem>
                        ))}
                        <SelectItem
                          value="NEW_TARGET"
                          label="+ Create new target..."
                          className="text-primary font-semibold"
                        >
                          + Create new target...
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* New Target Name Input if creating new */}
                {isCreatingNewTarget && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-target-name">
                      Target Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      required
                      id="new-target-name"
                      data-testid="web-auto-new-target-name-input"
                      value={newTargetName}
                      onChange={(e) => setNewTargetName(e.target.value)}
                      disabled={isSubmitting}
                      autoFocus
                    />
                  </div>
                )}

                {/* Suite Name */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="suite-name">
                    Suite Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    required
                    id="suite-name"
                    data-testid="web-auto-name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isSubmitting}
                    autoFocus={!isCreatingNewTarget}
                  />
                </div>

                {/* Evaluator */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="eval-agent">Evaluator</Label>
                  <Select
                    value={selectedEvalId || "__none__"}
                    onValueChange={(val) => setSelectedEvalId(val === "__none__" ? "" : (val ?? ""))}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger id="eval-agent" data-testid="web-auto-evaluator-select" className="w-full">
                      <SelectValue placeholder="None">
                        {selectedEvalId === "" || selectedEvalId === "__none__"
                          ? "None"
                          : evaluators.find((a) => a.id === selectedEvalId)?.name || "None"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" label="None">
                        None
                      </SelectItem>
                      {evaluators.map((a) => (
                        <SelectItem key={a.id} value={a.id} label={a.name}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* MCP Server */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-server">MCP Server</Label>
                  <Select
                    value={effectiveMcpId || "__none__"}
                    onValueChange={(val) => setUserSelectedMcpId(val === "__none__" ? "" : (val ?? ""))}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger id="mcp-server" data-testid="web-auto-mcp-select" className="w-full">
                      <SelectValue placeholder="None">
                        {effectiveMcpId === "" || effectiveMcpId === "__none__"
                          ? "None"
                          : mcpServers.find((s) => s.id === effectiveMcpId)?.name || "None"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" label="None">
                        None
                      </SelectItem>
                      {mcpServers.map((s) => (
                        <SelectItem key={s.id} value={s.id} label={s.name}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Description */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Brief description of this suite's test scope"
                    rows={3}
                    className="resize-none"
                    disabled={isSubmitting}
                  />
                </div>
              </TabsContent>

              <TabsContent value="variables" className="mt-0 py-1">
                <SuiteVariablesEditor
                  ref={variablesEditorRef}
                  variables={variables}
                  onChange={setVariables}
                  allowCredentials={true}
                  disabled={isSubmitting}
                />
              </TabsContent>
            </div>
          </Tabs>
        )}

        <DialogFooter className="mt-2 pt-2 border-t">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            data-testid="cancel-web-auto-suite-button"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              isSubmitting ||
              !name.trim() ||
              (isCreatingNewTarget && !newTargetName.trim())
            }
            data-testid="save-web-auto-suite-button"
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
  );
}
