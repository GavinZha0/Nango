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

  // Compute active server ID by combining form state, props, and suite metadata
  const effectiveServerId = useMemo(() => {
    if (form.mcpServerId) return form.mcpServerId;
    if (serverId) return serverId;
    if (caseRow?.mcpServerId) return caseRow.mcpServerId;
    if (form.suiteId) {
      const match = allSuites.find((s) => s.id === form.suiteId);
      if (match?.mcpServerId) return match.mcpServerId;
    }
    return "";
  }, [form.mcpServerId, serverId, caseRow?.mcpServerId, form.suiteId, allSuites]);

  const suitesList = useMemo(() => {
    if (!effectiveServerId) return allSuites;
    return allSuites.filter((s) => s.mcpServerId === effectiveServerId);
  }, [allSuites, effectiveServerId]);

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

    fetch("/api/verification-suites")
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
  const tools = useMemo(() => {
    if (!effectiveServerId) return [];
    const server = servers.find((s) => s.id === effectiveServerId);
    const list = (server?.tools ?? []).map((t) => t.name);
    return [...list].sort();
  }, [effectiveServerId, servers]);

  const trimmedName = form.name.trim();
  const hasValidSuite = form.suiteId !== "";

  const isDirty = caseRow
    ? trimmedName !== caseRow.name || form.suiteId !== caseRow.suiteId
    : true;

  const canSubmit =
    !submitting &&
    trimmedName.length > 0 &&
    hasValidSuite &&
    isDirty &&
    (caseRow ? true : effectiveServerId !== "" && form.toolName !== "");

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      let resultRow: VerificationCaseRow;
      const targetServerId = effectiveServerId;

      if (caseRow) {
        // Edit mode: allows renaming and/or moving to another suite under same server
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
          mcpServerId: targetServerId,
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

      // Refresh cases for this server to ensure the changes appear across suites
      if (targetServerId) {
        void caseActions.refreshForServer(targetServerId);
      }

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
      <DialogContent className="sm:max-w-xl">
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
                <div className="text-xs font-mono bg-muted/40 border rounded-md px-3 py-2 truncate text-foreground">
                  {servers.find((s) => s.id === (caseRow?.mcpServerId || serverId))?.serverTitle ||
                    servers.find((s) => s.id === (caseRow?.mcpServerId || serverId))?.name ||
                    (caseRow?.mcpServerId || serverId)}
                </div>
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
                <div
                  className="text-xs font-mono bg-muted/40 border rounded-md px-3 py-2 break-all text-foreground select-text"
                  title={caseRow.toolName ?? undefined}
                >
                  {caseRow.toolName}
                </div>
              ) : (
                <Select
                  value={form.toolName}
                  onValueChange={(v) =>
                    setForm((prev) => ({ ...prev, toolName: v ?? "" }))
                  }
                  disabled={!form.mcpServerId}
                >
                  <SelectTrigger id="case-tool" className="w-full font-mono text-xs">
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
                  <SelectContent className="max-h-[300px]">
                    {tools.map((t) => (
                      <SelectItem key={t} value={t} label={t} className="font-mono text-xs">
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
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
