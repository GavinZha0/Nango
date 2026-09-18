"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { Loader2, Plus, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
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
import {
  verificationActions,
  type VerificationSuiteRow,
  type VerificationGroupRow,
  type ToolPrefixRule,
  type PatchSuiteInput,
} from "@/store/verification";

interface McpServerItem {
  id: string;
  name: string;
  group?: string | null;
  serverTitle?: string | null;
}

function getServerDisplayName(s?: McpServerItem | null): string {
  if (!s) return "";
  const base = s.serverTitle || s.name;
  return s.group?.trim() ? `${s.group.trim()}/${base}` : base;
}

export interface VerificationSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suite?: VerificationSuiteRow | null;
  serverName?: string;
  defaultServerId?: string;
  defaultGroupId?: string;
  onCreated?: (created: VerificationSuiteRow) => void;
  onUpdated?: (updated: PatchSuiteInput) => Promise<void>;
}

export function VerificationSuiteDialog({
  open,
  onOpenChange,
  suite,
  serverName,
  defaultServerId,
  defaultGroupId,
  onCreated,
  onUpdated,
}: VerificationSuiteDialogProps): ReactNode {
  const isEdit = !!suite;

  const [activeTab, setActiveTab] = useState<string>("general");
  const [name, setName] = useState<string>(suite?.name ?? "");
  const [description, setDescription] = useState<string>(suite?.description ?? "");
  const [variables, setVariables] = useState<SuiteVariablesMap>(
    (suite?.variables as SuiteVariablesMap) ?? {},
  );
  const [serverId, setServerId] = useState<string>(suite?.mcpServerId ?? defaultServerId ?? "");
  const [selectedGroupId, setSelectedGroupId] = useState<string>(suite?.groupId ?? defaultGroupId ?? "none");
  const [customGroupName, setCustomGroupName] = useState<string>("");
  const [prefixMode, setPrefixMode] = useState<"none" | "add" | "remove">(
    suite?.toolPrefixRule?.mode ?? "none",
  );
  const [prefixText, setPrefixText] = useState<string>(suite?.toolPrefixRule?.prefix ?? "");

  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [groups, setGroups] = useState<VerificationGroupRow[]>([]);
  const [loadingServers, setLoadingServers] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const variablesEditorRef = useRef<SuiteVariablesEditorRef>(null);

  const [lastOpen, setLastOpen] = useState<boolean>(open);
  const [lastSuiteId, setLastSuiteId] = useState<string | undefined>(suite?.id);

  if (open !== lastOpen || suite?.id !== lastSuiteId) {
    setLastOpen(open);
    setLastSuiteId(suite?.id);
    if (open) {
      setActiveTab("general");
      setName(suite?.name ?? "");
      setDescription(suite?.description ?? "");
      setVariables((suite?.variables as SuiteVariablesMap) ?? {});
      setServerId(suite?.mcpServerId ?? defaultServerId ?? "");
      setSelectedGroupId(suite?.groupId ?? defaultGroupId ?? "none");
      setCustomGroupName("");
      setPrefixMode(suite?.toolPrefixRule?.mode ?? "none");
      setPrefixText(suite?.toolPrefixRule?.prefix ?? "");
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingServers(true);

    Promise.all([
      fetch("/api/mcp-servers").then((res) => (res.ok ? res.json() : [])),
      fetch("/api/verification-groups").then((res) => (res.ok ? res.json() : [])),
    ])
      .then(([serverRows, groupRows]: [McpServerItem[], VerificationGroupRow[]]) => {
        if (cancelled) return;
        setServers(serverRows);
        setGroups(groupRows);
        if (!isEdit && !defaultServerId && serverRows.length > 0) {
          setServerId((prev) => prev || serverRows[0].id);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingServers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, isEdit, defaultServerId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Please provide a suite name.");
      return;
    }

    if (prefixMode !== "none" && !prefixText.trim()) {
      setError("Please provide a tool prefix string or set mode to None.");
      return;
    }

    if (selectedGroupId === "__new__" && !customGroupName.trim()) {
      setError("Please provide a name for the new group.");
      return;
    }

    const toolPrefixRule: ToolPrefixRule | null =
      prefixMode === "none"
        ? null
        : { mode: prefixMode, prefix: prefixText.trim() };

    const resolvedGroupId =
      selectedGroupId === "__new__"
        ? undefined
        : selectedGroupId === "none" || !selectedGroupId
        ? null
        : selectedGroupId;
    const resolvedGroupName =
      selectedGroupId === "__new__" ? customGroupName.trim() : undefined;

    if (isEdit) {
      setSubmitting(true);
      setError(null);
      try {
        await onUpdated?.({
          name: trimmedName,
          description: description.trim() || null,
          groupId: resolvedGroupId,
          groupName: resolvedGroupName,
          mcpServerId: serverId || null,
          toolPrefixRule,
          variables,
        });
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!serverId) {
      setError("Please select an MCP server.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const created = await verificationActions.create({
        mcpServerId: serverId,
        groupId: resolvedGroupId,
        groupName: resolvedGroupName,
        toolPrefixRule,
        name: trimmedName,
        description: description.trim() || null,
        variables,
      });
      if (created) {
        toast.success("Verification suite created");
        onCreated?.(created);
        onOpenChange(false);
      } else {
        setError("Failed to create verification suite");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isDetached = isEdit && !suite?.mcpServerId && !!(suite?.mcpServerName || serverName);
  const displayServerName =
    serverName ||
    suite?.mcpServerName ||
    (serverId ? getServerDisplayName(servers.find((s) => s.id === serverId)) || "MCP Server" : "MCP Server");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl h-[720px] max-h-[92vh] flex flex-col">
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <DialogHeader className="flex flex-row items-center justify-between border-b pb-3 pr-8 shrink-0">
              <div className="flex items-center gap-3">
                <DialogTitle className="text-base font-semibold leading-none">
                  {isEdit ? "Edit Suite" : "New Suite"}
                </DialogTitle>
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
                          disabled={submitting}
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

            {error && (
              <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive my-2">
                {error}
              </p>
            )}

            <div className="flex-1 overflow-y-auto pr-1 mt-3">
              <TabsContent value="general" className="mt-0 space-y-4 py-1">
                {/* Group Selection */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="suite-group">Group</Label>
                  <Select
                    value={selectedGroupId}
                    onValueChange={(val) => setSelectedGroupId(val ?? "none")}
                    disabled={submitting}
                  >
                    <SelectTrigger id="suite-group" className="w-full" data-testid="suite-group-select">
                      <SelectValue placeholder="Select Group">
                        {selectedGroupId === "none" || !selectedGroupId
                          ? "Ungrouped"
                          : selectedGroupId === "__new__"
                          ? "+ Create New Group..."
                          : groups.find((g) => g.id === selectedGroupId)?.name || "Group"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Ungrouped</SelectItem>
                      {groups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.name}
                        </SelectItem>
                      ))}
                      <SelectItem value="__new__">+ Create New Group...</SelectItem>
                    </SelectContent>
                  </Select>
                  {selectedGroupId === "__new__" && (
                    <Input
                      placeholder="Enter new group name..."
                      maxLength={64}
                      value={customGroupName}
                      onChange={(e) => setCustomGroupName(e.target.value)}
                      disabled={submitting}
                      className="mt-1"
                      autoFocus
                      data-testid="new-group-name-input"
                    />
                  )}
                </div>

                {/* Suite Name */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="suite-name">
                    Suite Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="suite-name"
                    required
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={submitting}
                    data-testid="suite-name-input"
                  />
                </div>

                {/* Detached banner */}
                {isDetached && (
                  <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                    <div>
                      <p className="font-semibold">Bound MCP Server Deleted</p>
                      <p className="text-[11px] opacity-90 mt-0.5">
                        The original server <code>{displayServerName}</code> no longer exists. You can re-bind this suite by selecting an available server below.
                      </p>
                    </div>
                  </div>
                )}

                {/* MCP Server Selection */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-server">
                    MCP Server {!isEdit && <span className="text-destructive">*</span>}
                  </Label>
                  <Select
                    value={serverId}
                    onValueChange={(val) => setServerId(val ?? "")}
                    disabled={loadingServers || submitting || (!isDetached && isEdit && !!defaultServerId)}
                  >
                    <SelectTrigger id="mcp-server" className="w-full" data-testid="suite-server-select">
                      <SelectValue placeholder="Select an MCP Server">
                        {serverId ? (
                          getServerDisplayName(servers.find((s) => s.id === serverId)) || (isDetached ? `${displayServerName} (Deleted)` : "Unknown server")
                        ) : isDetached ? (
                          "Select a server to re-bind..."
                        ) : null}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {servers.map((s) => {
                        const label = getServerDisplayName(s);
                        return (
                          <SelectItem key={s.id} value={s.id} label={label}>
                            {label}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>

                {/* MCP Tool Prefix */}
                <div className="flex flex-col gap-1.5">
                  <Label>MCP Tool Prefix</Label>
                  <div className="grid grid-cols-3 gap-2">
                    <Select
                      value={prefixMode}
                      onValueChange={(val) => setPrefixMode((val ?? "none") as "none" | "add" | "remove")}
                      disabled={submitting}
                    >
                      <SelectTrigger className="w-full" data-testid="tool-prefix-mode-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="add">Add Prefix</SelectItem>
                        <SelectItem value="remove">Remove Prefix</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="col-span-2">
                      <Input
                        placeholder={prefixMode === "none" ? "No prefix transformation" : "e.g. weather_"}
                        value={prefixText}
                        onChange={(e) => setPrefixText(e.target.value)}
                        disabled={submitting || prefixMode === "none"}
                        maxLength={64}
                        data-testid="tool-prefix-input"
                      />
                    </div>
                  </div>
                </div>

                {/* Description */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="suite-desc">Description</Label>
                  <Textarea
                    id="suite-desc"
                    placeholder="Brief description of this suite's scope"
                    rows={3}
                    className="resize-none"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={submitting}
                    data-testid="suite-description-input"
                  />
                </div>
              </TabsContent>

              <TabsContent value="variables" className="mt-0 py-1">
                <SuiteVariablesEditor
                  ref={variablesEditorRef}
                  variables={variables}
                  onChange={setVariables}
                  allowCredentials={false}
                  disabled={submitting}
                />
              </TabsContent>
            </div>
          </Tabs>

          <DialogFooter className="mt-2 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="cancel-suite-button"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !name.trim() || (!isEdit && !serverId)}
              data-testid="save-suite-button"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
