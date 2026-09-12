"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";
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
import { verificationActions, type VerificationSuiteRow } from "@/store/verification";

interface McpServerItem {
  id: string;
  name: string;
  serverTitle?: string | null;
}

export interface VerificationSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suite?: (VerificationSuiteRow | { id: string; name: string; description?: string | null; mcpServerId?: string; serverName?: string; variables?: Record<string, unknown> }) | null;
  serverName?: string;
  defaultServerId?: string;
  onCreated?: (created: VerificationSuiteRow) => void;
  onUpdated?: (updated: { name: string; description?: string | null; variables?: Record<string, unknown> }) => Promise<void>;
}

export function VerificationSuiteDialog({
  open,
  onOpenChange,
  suite,
  serverName,
  defaultServerId,
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
  const [servers, setServers] = useState<McpServerItem[]>([]);
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
      setError(null);
    }
  }

  useEffect(() => {
    if (!open || isEdit) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingServers(true);

    fetch("/api/mcp-servers")
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: McpServerItem[]) => {
        if (cancelled) return;
        setServers(rows);
        if (!defaultServerId && rows.length > 0) {
          setServerId((prev) => prev || rows[0].id);
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

    if (isEdit) {
      setSubmitting(true);
      setError(null);
      try {
        await onUpdated?.({
          name: trimmedName,
          description: description.trim() || null,
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
        category: "mcp",
        mcpServerId: serverId,
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

  const displayServerName =
    serverName ||
    ("serverName" in (suite ?? {}) ? (suite as { serverName?: string }).serverName : undefined) ||
    (serverId ? servers.find((s) => s.id === serverId)?.serverTitle || servers.find((s) => s.id === serverId)?.name : "MCP Server");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl h-[600px] max-h-[85vh] flex flex-col">
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
                {/* MCP Server Selection or Readonly */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-server">
                    MCP Server {!isEdit && <span className="text-destructive">*</span>}
                  </Label>
                  {isEdit ? (
                    <Input
                      id="mcp-server"
                      value={displayServerName}
                      disabled
                      className="bg-muted cursor-not-allowed opacity-80"
                    />
                  ) : (
                    <Select
                      required
                      value={serverId}
                      onValueChange={(val) => setServerId(val ?? "")}
                      disabled={loadingServers || submitting || !!defaultServerId}
                    >
                      <SelectTrigger id="mcp-server" className="w-full" data-testid="suite-server-select">
                        <SelectValue placeholder="Select an MCP Server">
                          {serverId ? (
                            servers.find((s) => s.id === serverId)?.serverTitle ||
                            servers.find((s) => s.id === serverId)?.name ||
                            "Unknown server"
                          ) : null}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {servers.map((s) => (
                          <SelectItem key={s.id} value={s.id} label={s.serverTitle || s.name}>
                            {s.serverTitle || s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                    autoFocus
                    data-testid="suite-name-input"
                  />
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
