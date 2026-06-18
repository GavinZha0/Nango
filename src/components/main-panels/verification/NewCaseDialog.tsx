"use client";

/**
 * NewCaseDialog — modal for creating a verification case under an
 * MCP suite. Cascading pickers:
 *
 *   MCP Server (from /api/mcp-servers, visibility-scoped to the user)
 *     └─ Tool (from `server.tools` snapshot, captured at last discover)
 *
 * Tool list freshness: we DO NOT trigger a discover here — the snapshot
 * on the row is the source of truth and is refreshed by McpPanel when
 * the admin clicks "Refresh tools". If a server has `tools = null`
 * (never discovered) we surface a hint so the user knows what to do.
 *
 * Initial `input` and `assertions` are EMPTY — that's a deliberate
 * "smoke test" case (docs/verification.md): empty assertions ⇒
 * passes iff the tool returns without error. Users edit afterwards.
 *
 * Workflow cases are V2-only; the parent gates by `suite.category`
 * and never opens this dialog for workflow suites.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

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
import type { McpToolSnapshot } from "@/lib/db/schema";
import { caseActions, type VerificationCaseRow } from "@/store/verification-cases";

// --- API row (subset we need) ----------------------------------------------

interface McpServerRow {
  id: string;
  name: string;
  enabled: boolean;
  tools: McpToolSnapshot[] | null;
}

// --- Hoisted fetcher (lint-clean: setState only fires in promise callbacks) -

async function fetchMcpServers(): Promise<McpServerRow[]> {
  const res = await fetch("/api/mcp-servers");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as McpServerRow[];
}

// --- Component --------------------------------------------------------------

export interface NewCaseDialogProps {
  suiteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create. Parent typically selects it. */
  onCreated?: (row: VerificationCaseRow) => void;
}

export function NewCaseDialog({
  suiteId,
  open,
  onOpenChange,
  onCreated,
}: NewCaseDialogProps): ReactNode {
  // Remote data
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loadingServers, setLoadingServers] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state — reset on each open.
  const [form, setForm] = useState({ name: "", mcpServerId: "", toolName: "" });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fetch the server catalog on open. Cancellable so a rapid
  // open/close doesn't fire stale setState. The setLoading/setError
  // calls below are the canonical "fetch on mount/open" prelude; the
  // lint's reachability analysis can't see through the .then/.catch
  // boundary. Suppress per-call.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingServers(true);
    setLoadError(null);
    fetchMcpServers()
      .then((rows) => {
        if (cancelled) return;
        // Only enabled servers can be targeted — disabled ones won't
        // accept tool calls in the runner anyway.
        setServers(rows.filter((r) => r.enabled));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingServers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset the form on each open (cheaper than unmounting).
  // Use the "render-time detect prop change" pattern from McpPanel.
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setForm({ name: "", mcpServerId: "", toolName: "" });
      setSubmitError(null);
    }
  }

  // Tool list narrows to the selected server's snapshot.
  const selectedServer = useMemo(
    () => servers.find((s) => s.id === form.mcpServerId),
    [servers, form.mcpServerId],
  );
  const tools = useMemo<McpToolSnapshot[]>(() => {
    if (!selectedServer || !selectedServer.tools) return [];
    return selectedServer.tools.filter((t) => t.enabled);
  }, [selectedServer]);

  const canSubmit =
    form.name.trim().length > 0 &&
    form.mcpServerId !== "" &&
    form.toolName !== "" &&
    !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await caseActions.create(suiteId, {
        name: form.name.trim(),
        mcpServerId: form.mcpServerId,
        toolName: form.toolName,
        input: {},
        assertions: [],
      });
      if (created) {
        onOpenChange(false);
        onCreated?.(created);
      } else {
        // The store sets its own error; surface it here too for visibility.
        setSubmitError("Create failed. Please check the form and retry.");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New verification case</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Name */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="case-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="case-name"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. search returns at least one hit"
              autoFocus
            />
          </div>

          {/* MCP Server */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label>
              Server <span className="text-destructive">*</span>
            </Label>
            <Select
              value={form.mcpServerId}
              items={servers.map((s) => ({ value: s.id, label: s.name }))}
              onValueChange={(v) => {
                // Clear tool selection — it's scoped to the prior server.
                setForm((prev) => ({ ...prev, mcpServerId: v ?? "", toolName: "" }));
              }}
              disabled={loadingServers || servers.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    loadingServers
                      ? "Loading servers…"
                      : servers.length === 0
                        ? "No enabled servers"
                        : "Pick a server"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {servers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Tool */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label>
              Tool <span className="text-destructive">*</span>
            </Label>
            <Select
              value={form.toolName}
              onValueChange={(v) => setForm((prev) => ({ ...prev, toolName: v ?? "" }))}
              disabled={!selectedServer || tools.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    !selectedServer
                      ? "Pick a server first"
                      : !selectedServer.tools
                        ? "Discover tools in MCP panel first"
                        : tools.length === 0
                          ? "No enabled tools on this server"
                          : "Pick a tool"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {tools.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedServer && !selectedServer.tools && (
            <p className="text-[11px] text-muted-foreground">
              This server hasn&apos;t been discovered yet. Open the MCP panel
              and refresh the tool catalog, then come back here.
            </p>
          )}

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
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
