"use client";

/**
 * McpPanel — MCP server management in the left sidebar.
 */

import {
  Plug,
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  X,
  Globe,
  Lock,
  CircleCheck,
  CircleSlash,
  CircleAlert,
} from "lucide-react";
import {
  type ReactNode,
  useState,
  useEffect,
  useCallback,
  type FormEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useRouter, usePathname } from "next/navigation";
import { getProviderLabel } from "@/lib/constants/providers";
import type { McpToolSnapshot } from "@/lib/db/schema";

// Types

interface McpServerRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  url: string;
  headers: Record<string, string> | null;
  credentialId: string | null;
  credentialHeader: string | null;
  enabled: boolean;
  visibility: string;
  tools: McpToolSnapshot[] | null;
  // Server-reported metadata from the most recent `initialize`
  // handshake. All optional / nullable: a server before its first
  // discover, or one running an older MCP spec, may have all of
  // these as null. @see /api/mcp-servers/[id]/discover.
  serverName: string | null;
  serverVersion: string | null;
  serverTitle: string | null;
  serverDescription: string | null;
  serverInstructions: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface CredentialOption {
  id: string;
  name: string;
  provider: string | null;
}

// Server form dialog

interface HeaderEntry {
  key: string;
  value: string;
}

interface ServerFormState {
  name: string;
  type: "sse" | "http";
  url: string;
  credentialId: string;
  headers: HeaderEntry[];
  error: string;
}

function headersToEntries(headers: Record<string, string> | null): HeaderEntry[] {
  if (!headers) return [];
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

function entriesToHeaders(entries: HeaderEntry[]): Record<string, string> | null {
  const filtered = entries.filter((e) => e.key.trim());
  if (filtered.length === 0) return null;
  const result: Record<string, string> = {};
  for (const e of filtered) result[e.key.trim()] = e.value;
  return result;
}

function initialFormState(editing?: McpServerRow): ServerFormState {
  return {
    name: editing?.name ?? "",
    type: (editing?.type as "sse" | "http") ?? "http",
    url: editing?.url ?? "",
    credentialId: editing?.credentialId ?? "",
    headers: headersToEntries(editing?.headers ?? null),
    error: "",
  };
}

interface ServerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (server: McpServerRow) => void;
  editing?: McpServerRow;
  credentials: CredentialOption[];
}

function ServerFormDialog({
  open,
  onOpenChange,
  onSuccess,
  editing,
  credentials,
}: ServerFormDialogProps): ReactNode {
  const isEdit = Boolean(editing);
  const [form, setForm] = useState<ServerFormState>(initialFormState(editing));
  const [submitting, setSubmitting] = useState(false);

  // Reset form when dialog opens/closes or editing target changes.
  // Use a ref to detect prop changes without triggering the lint rule.
  const formKey = `${editing?.id ?? "new"}::${open}`;
  const [lastKey, setLastKey] = useState(formKey);
  if (formKey !== lastKey) {
    setLastKey(formKey);
    setForm(initialFormState(editing));
  }

  function setField<K extends keyof ServerFormState>(key: K, value: ServerFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function updateHeader(index: number, field: "key" | "value", val: string) {
    setForm((f) => {
      const next = [...f.headers];
      next[index] = { ...next[index], [field]: val };
      return { ...f, headers: next };
    });
  }

  function removeHeader(index: number) {
    setForm((f) => ({ ...f, headers: f.headers.filter((_, i) => i !== index) }));
  }

  function addHeader() {
    setForm((f) => ({ ...f, headers: [...f.headers, { key: "", value: "" }] }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setField("error", "");

    if (!form.name.trim() || !form.url.trim()) {
      setField("error", "Name and URL are required.");
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        type: form.type,
        url: form.url.trim(),
        credentialId: form.credentialId || null,
        headers: entriesToHeaders(form.headers),
      };

      const url = isEdit
        ? `/api/mcp-servers/${editing!.id}`
        : "/api/mcp-servers";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Standard error envelope from API HOFs is
        // `{ ok:false, code, message, requestId }`; `error` is kept
        // as a fallback for any un-migrated path.
        const data = (await res.json()) as { message?: string; error?: string };
        setField("error", data.message ?? data.error ?? "Request failed");
        return;
      }

      const server = (await res.json()) as McpServerRow;
      onOpenChange(false);
      onSuccess(server);
    } catch {
      setField("error", "Unexpected error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit MCP Server" : "New MCP Server"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3 py-2">
          {/* Name */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="mcp-name">Name <span className="text-destructive">*</span></Label>
            <Input
              id="mcp-name"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
              placeholder="e.g. My Search Server"
            />
          </div>

          {/* Transport Type */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label>Transport <span className="text-destructive">*</span></Label>
            <Select
              value={form.type}
              items={[
                { value: "http", label: "HTTP" },
                { value: "sse", label: "SSE" },
              ]}
              onValueChange={(v) => { if (v) setField("type", v as "http" | "sse"); }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="sse">SSE</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* URL */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="mcp-url">URL <span className="text-destructive">*</span></Label>
            <Input
              id="mcp-url"
              type="url"
              value={form.url}
              onChange={(e) => setField("url", e.target.value)}
              required
              placeholder="http://localhost:1234/mcp"
            />
          </div>

          {/* Credential */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label>Credential</Label>
            <Select
              value={form.credentialId}
              items={[
                { value: "", label: "None" },
                ...credentials.map((c) => ({
                  value: c.id,
                  label: c.name + (c.provider ? ` (${getProviderLabel(c.provider)})` : ""),
                })),
              ]}
              onValueChange={(v) => setField("credentialId", v ?? "")}
            >
              <SelectTrigger className="w-full" data-placeholder={!form.credentialId}>
                <SelectValue placeholder="None (no auth)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                {credentials.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}{c.provider ? ` (${getProviderLabel(c.provider)})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Headers */}
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Headers
              </p>
              <button
                type="button"
                onClick={addHeader}
                className="cursor-pointer inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>
            <p className="text-xs text-red-600 dark:text-red-400">
              Do NOT put API keys or tokens here. Use a Credential instead.
            </p>
            {form.headers.length > 0 && (
              <div className="space-y-1.5">
                {form.headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      value={h.key}
                      onChange={(e) => updateHeader(i, "key", e.target.value)}
                      placeholder="Header name"
                      className="h-7 text-xs flex-1"
                    />
                    <Input
                      value={h.value}
                      onChange={(e) => updateHeader(i, "value", e.target.value)}
                      placeholder="Value"
                      className="h-7 text-xs flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeHeader(i)}
                      className="cursor-pointer shrink-0 rounded p-0.5 text-muted-foreground/40 hover:text-destructive"
                      aria-label="Remove header"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {form.error && <p className="text-sm text-destructive">{form.error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (isEdit ? "Saving…" : "Creating…") : (isEdit ? "Save" : "Create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Section header

interface ServerHeaderProps {
  /** Active when the URL points at this server (`/mcp/test/<id>/...`).
   *  Used to highlight the row in the panel so users can see which
   *  server's tools the main panel is showing. */
  active: boolean;
  server: McpServerRow;
  isOwner: boolean;
  refreshing: boolean;
  /** Name-level click: select this server and navigate the main panel
   *  to its first tool. Scoped to the name text (not the whole row)
   *  to match Agent / Skill / DataSource / SSH panels and avoid
   *  hijacking clicks on the inline visibility / enabled toggles. */
  onSelect: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleVisibility: (visibility: string) => void;
  onDelete: () => void;
}

function ServerHeader({
  active,
  server,
  isOwner,
  refreshing,
  onSelect,
  onEdit,
  onRefresh,
  onToggleEnabled,
  onToggleVisibility,
  onDelete,
}: ServerHeaderProps) {
  const toolCount = server.tools?.length ?? 0;
  const isPublic = server.visibility === "public";

  // Server-reported metadata captured during the last `initialize`
  // handshake. `serverDescription` (one-line) is preferred over
  // `serverInstructions` (longer-form) for the secondary header
  // line; fall back when only one is present. Both null on servers
  // running an older MCP spec / before the first discover scan.
  const subtitle = server.serverDescription ?? server.serverInstructions ?? null;
  const version = server.serverVersion ?? null;

  return (
    // Two rows so the description on line 2 can use the full panel
    // width — line 1 is constrained by the action icons on its right,
    // but line 2 sits below them and runs edge-to-edge. Disabled
    // servers fade to opacity-50 (matches agent rows); the action
    // icons stay clickable through the dim because opacity-50 is
    // purely visual, not pointer-blocking.
    //
    // Background: transparent in the resting state — the row used to
    // carry `bg-muted/40` to separate it from the nested tool list
    // that lived inside it, but the tool list moved to the main panel
    // so the contrast is no longer needed. `bg-accent` on active and
    // a faint hover keep the row recognisably interactive.
    <div className={cn(
      "flex flex-col gap-0.5 border-t border-border/60 first:border-t-0 px-2 py-1.5 transition-colors",
      active ? "bg-accent" : "hover:bg-muted/40",
      !server.enabled && "opacity-50",
    )}>
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <button
            type="button"
            onClick={onSelect}
            className="cursor-pointer truncate text-left text-base font-medium hover:underline underline-offset-2"
            aria-label={`Select ${server.name}`}
          >
            {server.name}
          </button>
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground shrink-0">
            {toolCount}
          </span>
          {version && (
            <span className="text-xs font-normal text-muted-foreground/60 shrink-0">
              v{version}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
        {/* Refresh tools */}
        {isOwner && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="cursor-pointer rounded p-0.5 text-muted-foreground/40 hover:text-foreground disabled:opacity-50"
            aria-label="Refresh tools"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          </button>
        )}

        {/* Edit */}
        {isOwner && (
          <button
            type="button"
            onClick={onEdit}
            className="cursor-pointer rounded p-0.5 text-muted-foreground/40 hover:text-foreground"
            aria-label="Edit server"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}

        {/* Delete */}
        {isOwner && (
          <button
            type="button"
            onClick={onDelete}
            className="cursor-pointer rounded p-0.5 text-muted-foreground/40 hover:text-destructive"
            aria-label="Delete server"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}

        {/* Visibility */}
        {isOwner ? (
          <button
            type="button"
            onClick={() => onToggleVisibility(isPublic ? "private" : "public")}
            className="cursor-pointer rounded p-0.5 text-muted-foreground/40 hover:text-foreground"
            aria-label={isPublic ? "Set to private" : "Set to public"}
          >
            {isPublic
              ? <Globe className="h-3 w-3 text-foreground/60" />
              : <Lock className="h-3 w-3" />
            }
          </button>
        ) : (
          isPublic
            ? <Globe className="h-3 w-3 text-muted-foreground/40" />
            : <Lock className="h-3 w-3 text-muted-foreground/40" />
        )}

        {/* Active — green check: ok, red alert: error, slash: disabled */}
        {isOwner ? (
          <button
            type="button"
            onClick={() => onToggleEnabled(!server.enabled)}
            className="cursor-pointer rounded p-0.5 hover:text-foreground"
            aria-label={server.enabled ? "Disable server" : "Enable server"}
          >
            {!server.enabled
              ? <CircleSlash className="h-3.5 w-3.5 text-foreground/70" />
              : toolCount > 0
                ? <CircleCheck className="h-3.5 w-3.5 text-green-400/50" />
                : <CircleAlert className="h-3.5 w-3.5 text-red-400/60" />
            }
          </button>
        ) : (
          !server.enabled
            ? <CircleSlash className="h-3.5 w-3.5 text-foreground/70" />
            : toolCount > 0
              ? <CircleCheck className="h-3.5 w-3.5 text-green-400/50" />
              : <CircleAlert className="h-3.5 w-3.5 text-red-400/60" />
        )}
        </div>
      </div>

      {/* Line 2 — server-reported description / instructions. Lives
          OUTSIDE the row-1 flex so it can run edge-to-edge instead of
          being clipped by the action icons on the right. Truncates
          with ellipsis; the panel is resizable, so users can widen
          it to read long descriptions instead of relying on a tooltip.
          ALWAYS rendered (falls back to a non-breaking space when the
          server has no description) so every row in the list has the
          same fixed height — visual scanning across rows is easier
          when items don't shift vertically.
          Passive (not clickable) to match the other left panels:
          navigation lives on the name only, so toggles in the right
          cluster don't compete with row-wide click bubbling. */}
      <p
        className="truncate text-xs font-normal text-muted-foreground/70"
        title={subtitle ?? undefined}
      >
        {subtitle ?? "\u00A0"}
      </p>
    </div>
  );
}

// Main component
//
// (`ToolRow` previously rendered inside an expandable section of each
// server row. The tool list moved into the main panel as a dedicated
// column with search, so it's no longer needed here — see
// `src/app/(workspace)/mcp/test/[serverId]/[toolName]/page.tsx`.)

export function McpPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Derive active server from URL: /mcp/test/<serverId>
  // (server row uses this for the active highlight; tool selection
  // lives in the main panel as component state, not in the URL.)
  const mcpTestMatch = pathname.match(/^\/mcp\/test\/([^/]+)/);
  const activeServerId = mcpTestMatch?.[1] ?? null;
  const [deleteTarget, setDeleteTarget] = useState<McpServerRow | null>(null);
  const [currentUserId, setCurrentUserId] = useState("");
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerRow | undefined>(undefined);
  // Per-server refreshing state
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());

  // Fetch current user ID
  useEffect(() => {
    async function fetchUserId() {
      try {
        const res = await fetch("/api/auth/get-session");
        if (res.ok) {
          const data = await res.json();
          setCurrentUserId(data?.user?.id ?? "");
        }
      } catch { /* silent */ }
    }
    void fetchUserId();
  }, []);

  // Refresh all — reload list from DB, then re-discover tools for each enabled server
  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/mcp-servers");
      if (res.ok) {
        const data = (await res.json()) as McpServerRow[];
        setServers(data);

        // Trigger discover for all enabled servers in parallel
        const enabledIds = data.filter((s) => s.enabled).map((s) => s.id);
        if (enabledIds.length > 0) {
          setRefreshingIds(new Set(enabledIds));
          await Promise.allSettled(
            enabledIds.map(async (id) => {
              try {
                const discoverRes = await fetch(`/api/mcp-servers/${id}/discover`, { method: "POST" });
                if (discoverRes.ok) {
                  const updated = (await discoverRes.json()) as McpServerRow;
                  setServers((prev) => prev.map((s) => s.id === id ? updated : s));
                } else {
                  setServers((prev) => prev.map((s) => s.id === id ? { ...s, tools: [] } : s));
                }
              } catch {
                setServers((prev) => prev.map((s) => s.id === id ? { ...s, tools: [] } : s));
              }
            })
          );
          setRefreshingIds(new Set());
        }
      }
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      try {
        const [serversRes, credsRes] = await Promise.all([
          fetch("/api/mcp-servers"),
          fetch("/api/tools"),
        ]);
        if (!cancelled && serversRes.ok) {
          const data = (await serversRes.json()) as McpServerRow[];
          setServers(data);
        }
        if (!cancelled && credsRes.ok) {
          const toolsData = await credsRes.json();
          setCredentials(toolsData.apiCredentials ?? []);
        }
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    }
    void init();
    return () => { cancelled = true; };
  }, []);

  // Dialog handlers

  function handleNewServer() {
    setEditingServer(undefined);
    setDialogOpen(true);
  }

  function handleEditServer(server: McpServerRow) {
    setEditingServer(server);
    setDialogOpen(true);
  }

  function handleDialogSuccess(server: McpServerRow) {
    if (editingServer) {
      // Update existing — then re-discover tools (URL/credential may have changed)
      setServers((prev) => prev.map((s) => s.id === server.id ? server : s));
    } else {
      // Add new
      setServers((prev) => [server, ...prev]);
    }
    void discoverTools(server.id);
  }

  /**
   * Select a server: navigate to its main panel. Tool selection is
   * handled inside that view as component state (no URL coupling),
   * so we always navigate to the same path regardless of whether
   * the server has tools — the page picks the first tool by default
   * and shows an empty state when there are none.
   */
  function handleSelectServer(server: McpServerRow) {
    router.push(`/mcp/test/${server.id}`);
  }

  // Discover tools

  async function discoverTools(serverId: string) {
    setRefreshingIds((prev) => new Set([...prev, serverId]));
    try {
      const res = await fetch(`/api/mcp-servers/${serverId}/discover`, { method: "POST" });
      if (res.ok) {
        const updated = (await res.json()) as McpServerRow;
        setServers((prev) => prev.map((s) => s.id === serverId ? updated : s));
      } else {
        // Discover failed — clear tools so icon turns red
        setServers((prev) => prev.map((s) => s.id === serverId ? { ...s, tools: [] } : s));
      }
    } catch {
      setServers((prev) => prev.map((s) => s.id === serverId ? { ...s, tools: [] } : s));
    }
    setRefreshingIds((prev) => {
      const next = new Set(prev);
      next.delete(serverId);
      return next;
    });
  }

  // Server operations

  async function handleToggleEnabled(server: McpServerRow, enabled: boolean) {
    setServers((prev) => prev.map((s) => s.id === server.id ? { ...s, enabled } : s));
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        setServers((prev) => prev.map((s) => s.id === server.id ? { ...s, enabled: !enabled } : s));
      }
    } catch {
      setServers((prev) => prev.map((s) => s.id === server.id ? { ...s, enabled: !enabled } : s));
    }
  }

  async function handleToggleVisibility(server: McpServerRow, visibility: string) {
    const prevVis = server.visibility;
    setServers((prev) => prev.map((s) => s.id === server.id ? { ...s, visibility } : s));
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      if (!res.ok) {
        setServers((p) => p.map((s) => s.id === server.id ? { ...s, visibility: prevVis } : s));
      }
    } catch {
      setServers((p) => p.map((s) => s.id === server.id ? { ...s, visibility: prevVis } : s));
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    const res = await fetch(`/api/mcp-servers/${deleteTarget.id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) {
      setServers((prev) => prev.filter((s) => s.id !== deleteTarget.id));
    }
    setDeleteTarget(null);
  }

  // Sorted servers

  const sortedServers = [...servers].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ServerFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={handleDialogSuccess}
        editing={editingServer}
        credentials={credentials}
      />

      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">MCP Servers</h2>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleNewServer}
              aria-label="New MCP server"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={refreshAll}
              disabled={loading}
              aria-label="Refresh all servers"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="py-1">
            {loading && servers.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">Loading…</p>
            ) : servers.length === 0 ? (
              <div className="px-4 py-4 text-xs text-muted-foreground">
                No MCP servers yet.{" "}
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                  onClick={handleNewServer}
                >
                  Add one
                </button>
              </div>
            ) : (
              <div>
                {sortedServers.map((server) => {
                  const isOwner = server.createdBy === currentUserId;
                  return (
                    <ServerHeader
                      key={server.id}
                      active={server.id === activeServerId}
                      server={server}
                      isOwner={isOwner}
                      refreshing={refreshingIds.has(server.id)}
                      onSelect={() => handleSelectServer(server)}
                      onEdit={() => handleEditServer(server)}
                      onRefresh={() => discoverTools(server.id)}
                      onToggleEnabled={(enabled) => handleToggleEnabled(server, enabled)}
                      onToggleVisibility={(vis) => handleToggleVisibility(server, vis)}
                      onDelete={() => setDeleteTarget(server)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* ── Delete confirmation dialog ──────────────────────────────── */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete MCP server</AlertDialogTitle>
              <AlertDialogDescription>
                Permanently delete <strong>{deleteTarget?.name}</strong>? This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteConfirm}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </div>
  );
}
