"use client";

import { useEffect, useState, useMemo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  caseActions,
  type VerificationCaseRow,
} from "@/store/verification-cases";
import { verificationActions } from "@/store/verification";

// --- Helpers ----------------------------------------------------------------

interface ErrorEnvelope {
  message?: string;
  code?: string;
}

interface McpServerListItem {
  id: string;
  name: string;
  serverTitle?: string | null;
  enabled: boolean;
  tools?: Array<{ name: string }>;
}

async function readApiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as ErrorEnvelope | null;
  return body?.message ?? `${res.status} ${res.statusText}`;
}

async function fetchMcpServers(): Promise<McpServerListItem[]> {
  const res = await fetch("/api/mcp-servers");
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as McpServerListItem[];
}

export interface NewCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: VerificationCaseRow) => void;
  suiteId?: string; // Optional: when provided, locks or pre-selects this suite
  serverId?: string; // Optional: when provided, locks selection to this server
  defaultToolName?: string; // Optional: default tool selected
  caseRow?: VerificationCaseRow | null; // Optional: when provided, runs in edit mode
}

export function NewCaseDialog({
  open,
  onOpenChange,
  onCreated,
  suiteId,
  serverId,
  defaultToolName,
  caseRow,
}: NewCaseDialogProps): ReactNode {
  const [servers, setServers] = useState<McpServerListItem[]>([]);
  const [allSuites, setAllSuites] = useState<Array<{ id: string; name: string; mcpServerId?: string | null }>>([]);
  const [loadingServers, setLoadingServers] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState({
    name: "",
    mcpServerId: serverId ?? "",
    toolName: defaultToolName ?? "",
    suiteId: suiteId ?? "",
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const suitesList = useMemo(() => {
    const targetServerId = form.mcpServerId || serverId || caseRow?.mcpServerId;
    if (!targetServerId) return allSuites;
    return allSuites.filter((s) => s.mcpServerId === targetServerId);
  }, [allSuites, form.mcpServerId, serverId, caseRow?.mcpServerId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingServers(true);
    setLoadError(null);
    fetchMcpServers()
      .then((rows) => {
        if (cancelled) return;
        setServers(rows.filter((r) => r.enabled));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingServers(false);
      });

    fetch("/api/verification-suites?category=mcp")
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: Array<{ id: string; name: string; mcpServerId?: string | null }>) => {
        if (cancelled) return;
        setAllSuites(rows);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset form when dialog opens
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      if (caseRow) {
        setForm({
          name: caseRow.name,
          mcpServerId: caseRow.mcpServerId ?? "",
          toolName: caseRow.toolName || "",
          suiteId: caseRow.suiteId,
        });
      } else {
        setForm({
          name: "",
          mcpServerId: serverId ?? "",
          toolName: defaultToolName ?? "",
          suiteId: suiteId ?? "",
        });
      }
      setSubmitError(null);
    }
  }

  // Derived tools list from active server metadata
  const [tools, setTools] = useState<string[]>([]);

  useEffect(() => {
    const activeServerId = form.mcpServerId;
    if (!activeServerId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTools([]);
      return;
    }
    const server = servers.find((s) => s.id === activeServerId);
    const list = (server?.tools ?? []).map((t) => t.name);
    const sorted = [...list].sort();
    setTools(sorted);
  }, [form.mcpServerId, servers]);

  const trimmedName = form.name.trim();
  const hasValidSuite = form.suiteId !== "";

  const canSubmit =
    !submitting &&
    trimmedName.length > 0 &&
    form.mcpServerId !== "" &&
    form.toolName !== "" &&
    hasValidSuite;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      let resultRow: VerificationCaseRow;

      if (caseRow) {
        // Edit mode
        const updated = await caseActions.patch(caseRow, {
          name: trimmedName,
          suiteId: form.suiteId,
        });
        if (!updated) {
          throw new Error("Failed to update case");
        }
        resultRow = updated;
        toast.success("Updated verification case", {
          description: `Case "${updated.name}" updated successfully.`,
        });
      } else {
        // Create mode
        const created = await caseActions.create({
          name: trimmedName,
          mcpServerId: form.mcpServerId,
          toolName: form.toolName,
          suiteId: form.suiteId,
          input: {},
        });
        if (!created) {
          throw new Error("Failed to create case");
        }
        resultRow = created;
        toast.success("Created verification case", {
          description: `Case "${created.name}"`,
        });
      }

      // Refresh cases for this server to ensure the new case appears in the list
      void caseActions.refreshForServer(form.mcpServerId);

      // Trigger store refresh for verification left panel servers list
      void verificationActions.refresh("mcp");

      onCreated(resultRow);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{caseRow ? "Edit Case" : "Add Case"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Server Selector */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <Label htmlFor="case-server">
                MCP Server <span className="text-destructive">*</span>
              </Label>
              {serverId || caseRow ? (
                <span className="text-sm font-mono truncate">
                  {servers.find((s) => s.id === (caseRow?.mcpServerId || serverId))?.serverTitle ||
                    servers.find((s) => s.id === (caseRow?.mcpServerId || serverId))?.name ||
                    (caseRow?.mcpServerId || serverId)}
                </span>
              ) : (
                <Select
                  value={form.mcpServerId}
                  onValueChange={(v) => {
                    const nextServerId = v ?? "";
                    const nextSuites = allSuites.filter((s) => s.mcpServerId === nextServerId);
                    const defaultSuiteId = nextSuites[0]?.id || "";
                    setForm((prev) => ({
                      ...prev,
                      mcpServerId: nextServerId,
                      toolName: "",
                      suiteId: defaultSuiteId,
                      newSuiteName: "",
                    }));
                  }}
                  disabled={loadingServers}
                >
                  <SelectTrigger id="case-server" className="w-full">
                    <SelectValue
                      placeholder={
                        loadingServers ? "Loading servers…" : "Select a server"
                      }
                    >
                      {form.mcpServerId ? (
                        servers.find((s) => s.id === form.mcpServerId)?.serverTitle ||
                        servers.find((s) => s.id === form.mcpServerId)?.name ||
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

            {/* Suite Selector */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <Label htmlFor="case-suite">
                Suite Name <span className="text-destructive">*</span>
              </Label>
              <Select
                value={form.suiteId}
                onValueChange={(v) =>
                  setForm((prev) => ({ ...prev, suiteId: v ?? "" }))
                }
                disabled={!form.mcpServerId}
              >
                <SelectTrigger id="case-suite" className="w-full">
                  <SelectValue
                    placeholder={
                      !form.mcpServerId
                        ? "Select a server first"
                        : "Select a suite"
                    }
                  >
                    {form.suiteId ? (
                      allSuites.find((s) => s.id === form.suiteId)?.name ||
                      suitesList.find((s) => s.id === form.suiteId)?.name ||
                      "Unknown suite"
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {suitesList.map((s) => (
                    <SelectItem key={s.id} value={s.id} label={s.name}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Tool Selector */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <Label htmlFor="case-tool">
                MCP Tool <span className="text-destructive">*</span>
              </Label>
              {caseRow ? (
                <span className="text-sm font-mono truncate">{caseRow.toolName}</span>
              ) : (
                <Select
                  value={form.toolName}
                  onValueChange={(v) =>
                    setForm((prev) => ({ ...prev, toolName: v ?? "" }))
                  }
                  disabled={!form.mcpServerId}
                >
                  <SelectTrigger id="case-tool" className="w-full">
                    <SelectValue
                      placeholder={
                        !form.mcpServerId
                          ? "Select a server first"
                          : "Select a tool"
                      }
                    >
                      {form.toolName ? form.toolName : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {tools.map((t) => (
                      <SelectItem key={t} value={t} label={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Case Name */}
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <Label htmlFor="case-name">
                Case Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="case-name"
                value={form.name}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, name: e.target.value }))
                }
                required
              />
            </div>

            {(loadError || submitError) && (
              <p className="text-xs text-destructive">
                {submitError ?? loadError}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
            >
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {caseRow ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
