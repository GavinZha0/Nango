"use client";

/**
 * SshServerPanel — left-panel surface for the agent-facing
 * @see docs/ssh.md §3
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  CircleCheck,
  CircleSlash,
  Globe,
  Lock,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface SshServerRow {
  id: string;
  name: string;
  description: string | null;
  host: string;
  port: number;
  enabled: boolean;
  visibility: string;
  createdBy: string;
}

interface RowItemProps {
  row: SshServerRow;
  /** True when the current route is /ssh-server/<row.id>. Drives the
   *  selected-row highlight so users see which item the main panel
   *  is showing. Mirrors McpPanel's active row pattern. */
  active: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  onEdit: (row: SshServerRow) => void;
  onToggleEnabled: (row: SshServerRow, next: boolean) => void;
  onToggleVisibility: (row: SshServerRow, next: "private" | "public") => void;
}

/**
 * One SSH server row. Three-line layout tailored to SSH:
 *   line 1 — name (left) + visibility + enabled toggle (right)
 *   line 2 — host:port, mono + muted (full FQDN can be long, so it
 *            gets its own line instead of competing with the name)
 *   line 3 — description (only rendered when present)
 *
 * Differs from DataSource / Skills / Agent rows (single-line metadata
 * chip + optional description) because SSH host strings routinely
 * exceed the available chip width — moving host to its own line keeps
 * the name readable and the address legible.
 */
function SshServerRowItem({
  row,
  active,
  isOwner,
  isAdmin,
  onEdit,
  onToggleEnabled,
  onToggleVisibility,
}: RowItemProps): ReactNode {
  const isPublic = row.visibility === "public";
  const canEdit = isOwner || isAdmin;
  const canToggleEnabled = isOwner || isAdmin;
  const canToggleVisibility = isOwner;
  const hostLabel = row.port !== 22 ? `${row.host}:${row.port}` : row.host;

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      {/* Line 1: name + right-side icons */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {canEdit ? (
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="cursor-pointer block truncate text-left text-base font-medium hover:underline underline-offset-2"
              aria-label={`Edit ${row.name}`}
            >
              {row.name}
            </button>
          ) : (
            <span className="block truncate text-base font-medium">
              {row.name}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canToggleVisibility ? (
            <button
              type="button"
              onClick={() => onToggleVisibility(row, isPublic ? "private" : "public")}
              className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
              aria-label={isPublic ? "Set to private" : "Set to public"}
            >
              {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span
              className="p-0.5 text-muted-foreground/70"
              aria-label={isPublic ? "Public SSH server" : "Private SSH server"}
            >
              {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            </span>
          )}

          {canToggleEnabled ? (
            <button
              type="button"
              onClick={() => onToggleEnabled(row, !row.enabled)}
              className="cursor-pointer rounded p-0.5 hover:text-foreground"
              aria-label={row.enabled ? "Disable SSH server" : "Enable SSH server"}
            >
              {row.enabled ? (
                <CircleCheck className="h-3.5 w-3.5 text-green-400/50" />
              ) : (
                <CircleSlash className="h-3.5 w-3.5 text-foreground/70" />
              )}
            </button>
          ) : (
            <span className="p-0.5">
              {row.enabled ? (
                <CircleCheck className="h-3.5 w-3.5 text-green-400/50" />
              ) : (
                <CircleSlash className="h-3.5 w-3.5" />
              )}
            </span>
          )}
        </div>
      </div>

      {/* Line 2: host:port — own line so long FQDNs don't crowd the name */}
      <p
        className="truncate font-mono text-[11px] leading-tight text-muted-foreground"
        title={hostLabel}
      >
        {hostLabel}
      </p>

      {/* Line 3: description (optional) */}
      {row.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
      )}
    </div>
  );
}

export function SshServerPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  // Active row id: derived from /ssh-server/<id>. `new` is the
  // create-page sentinel; skipping it keeps the highlight off when
  // the user is mid-creation. Mirrors McpPanel / SkillsPanel.
  const sshMatch = pathname.match(/^\/ssh-server\/([^/]+)/);
  const activeSshServerId =
    sshMatch && sshMatch[1] !== "new" ? sshMatch[1] : null;

  const [rows, setRows] = useState<SshServerRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [currentUserRole, setCurrentUserRole] = useState<string>("user");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/auth/get-session");
        if (res.ok) {
          const data = (await res.json()) as { user?: { id?: string; role?: string } };
          setCurrentUserId(data?.user?.id ?? "");
          setCurrentUserRole(data?.user?.role ?? "user");
        }
      } catch {
        /* silent */
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/ssh-servers");
      if (res.ok) {
        const data = (await res.json()) as SshServerRow[];
        setRows(data);
      }
    } catch {
      /* silent */
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init(): Promise<void> {
      try {
        const res = await fetch("/api/ssh-servers");
        if (!cancelled && res.ok) {
          const data = (await res.json()) as SshServerRow[];
          setRows(data);
        }
      } catch {
        /* silent */
      }
      if (!cancelled) setLoading(false);
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
  }, [rows]);

  const isAdmin = currentUserRole === "admin";

  async function handleToggleEnabled(
    row: SshServerRow,
    enabled: boolean,
  ): Promise<void> {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      const res = await fetch(`/api/ssh-servers/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, enabled: !enabled } : r)),
      );
    }
  }

  async function handleToggleVisibility(
    row: SshServerRow,
    visibility: "private" | "public",
  ): Promise<void> {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, visibility } : r)));
    try {
      const res = await fetch(`/api/ssh-servers/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, visibility: row.visibility } : r)),
      );
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Server className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">SSH Hosts</h2>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => router.push("/ssh-server/new")}
            aria-label="New SSH server"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh SSH servers"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No SSH servers yet.{" "}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => router.push("/ssh-server/new")}
            >
              Create one
            </button>
          </div>
        ) : (
          <div>
            {sortedRows.map((row) => (
              <SshServerRowItem
                key={row.id}
                row={row}
                active={row.id === activeSshServerId}
                isOwner={row.createdBy === currentUserId}
                isAdmin={isAdmin}
                onEdit={(r) => router.push(`/ssh-server/${r.id}`)}
                onToggleEnabled={handleToggleEnabled}
                onToggleVisibility={handleToggleVisibility}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
