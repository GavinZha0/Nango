"use client";

import { useState, useEffect, type ReactNode } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { verificationActions, type VerificationSuiteRow } from "@/store/verification";

interface McpServerItem {
  id: string;
  name: string;
  serverTitle?: string | null;
}

export interface VerificationSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suite?: { id: string; name: string; description?: string | null; mcpServerId?: string; serverName?: string } | null;
  serverName?: string;
  defaultServerId?: string;
  onCreated?: (created: VerificationSuiteRow) => void;
  onUpdated?: (name: string) => Promise<void>;
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

  const [name, setName] = useState<string>(suite?.name ?? "");
  const [description, setDescription] = useState<string>(suite?.description ?? "");
  const [serverId, setServerId] = useState<string>(suite?.mcpServerId ?? defaultServerId ?? "");
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [loadingServers, setLoadingServers] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [lastOpen, setLastOpen] = useState<boolean>(open);
  const [lastSuiteId, setLastSuiteId] = useState<string | undefined>(suite?.id);

  if (open !== lastOpen || suite?.id !== lastSuiteId) {
    setLastOpen(open);
    setLastSuiteId(suite?.id);
    if (open) {
      setName(suite?.name ?? "");
      setDescription(suite?.description ?? "");
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
        await onUpdated?.(trimmedName);
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

  const displayServerName = serverName || suite?.serverName || (serverId ? servers.find((s) => s.id === serverId)?.serverTitle || servers.find((s) => s.id === serverId)?.name : "MCP Server");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit Suite" : "New Suite"}</DialogTitle>
          </DialogHeader>

          {error && (
            <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {/* MCP Server Selection or Readonly */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-server">MCP Server {!isEdit && <span className="text-destructive">*</span>}</Label>
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
                <SelectTrigger id="mcp-server" className="w-full">
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
            <Label htmlFor="suite-name">Suite Name <span className="text-destructive">*</span></Label>
            <Input
              id="suite-name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          {/* Description (Only in New Mode) */}
          {!isEdit && (
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
              />
            </div>
          )}

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim() || (!isEdit && !serverId)}>
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
