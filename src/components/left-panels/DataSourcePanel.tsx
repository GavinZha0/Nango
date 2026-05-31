"use client";

/**
 * DataSourcePanel — left-panel surface for the agent-facing
 * See docs/data-sources.md.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Database,
  Globe,
  Lock,
  Plus,
  RefreshCw,
  CircleCheck,
  CircleSlash,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// Row shape

interface DataSourceRow {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  host: string;
  port: number;
  database: string;
  enabled: boolean;
  visibility: string;
  createdBy: string;
}

// Row component

interface DataSourceRowItemProps {
  row: DataSourceRow;
  /** True when the current route is /datasource/<row.id>. Drives the
   *  selected-row highlight so users see which item the main panel
   *  is showing. Mirrors McpPanel's active row pattern. */
  active: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  onEdit: (row: DataSourceRow) => void;
  onToggleEnabled: (row: DataSourceRow, next: boolean) => void;
  onToggleVisibility: (row: DataSourceRow, next: "private" | "public") => void;
}

/**
 * One data source row. Three-line layout (mirrors SshServerPanel):
 *   line 1 — name + provider chip (left) + visibility + enabled (right)
 *   line 2 — host:port/database, mono + muted; gets its own line
 *            because FQDN + non-default port can easily exceed the
 *            chip width and would otherwise crowd the name
 *   line 3 — description (only when present)
 *
 * Provider chip stays on line 1 so the engine (postgres / mysql /
 * vertica) is glanceable at the same vertical level as the name.
 *
 * Delete intentionally NOT shown here — destructive actions live in
 * the editor's header (next to Save), so the list stays clean of
 * accidental-click targets.
 */
function DataSourceRowItem({
  row,
  active,
  isOwner,
  isAdmin,
  onEdit,
  onToggleEnabled,
  onToggleVisibility,
}: DataSourceRowItemProps): ReactNode {
  const isPublic = row.visibility === "public";
  const canEdit = isOwner || isAdmin;
  const canToggleEnabled = isOwner || isAdmin;
  const canToggleVisibility = isOwner;
  const target = `${row.host}:${row.port}/${row.database}`;

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      {/* Line 1: name + provider chip + right-side icons */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {canEdit ? (
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="cursor-pointer truncate text-left text-base font-medium hover:underline underline-offset-2"
              aria-label={`Edit ${row.name}`}
            >
              {row.name}
            </button>
          ) : (
            <span className="truncate text-base font-medium">
              {row.name}
            </span>
          )}
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono leading-none uppercase text-foreground/70">
            {row.provider}
          </span>
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
              aria-label={isPublic ? "Public data source" : "Private data source"}
            >
              {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            </span>
          )}

          {canToggleEnabled ? (
            <button
              type="button"
              onClick={() => onToggleEnabled(row, !row.enabled)}
              className="cursor-pointer rounded p-0.5 hover:text-foreground"
              aria-label={row.enabled ? "Disable data source" : "Enable data source"}
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

      {/* Line 2: host:port/database — own line so long FQDNs don't crowd the name */}
      <p
        className="truncate font-mono text-[11px] leading-tight text-muted-foreground"
        title={target}
      >
        {target}
      </p>

      {/* Line 3: description (optional) */}
      {row.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
      )}
    </div>
  );
}

// Main component

export function DataSourcePanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  // Active row id: derived from /datasource/<id>. `new` is the
  // create-page sentinel; skipping it keeps the highlight off when
  // the user is mid-creation. Mirrors McpPanel / SkillsPanel.
  const dsMatch = pathname.match(/^\/datasource\/([^/]+)/);
  const activeDataSourceId =
    dsMatch && dsMatch[1] !== "new" ? dsMatch[1] : null;

  const [rows, setRows] = useState<DataSourceRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [currentUserRole, setCurrentUserRole] = useState<string>("user");

  // Fetch current user once for RBAC checks (matches SkillsPanel).
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
      const res = await fetch("/api/data-sources");
      if (res.ok) {
        const data = (await res.json()) as DataSourceRow[];
        setRows(data);
      }
    } catch {
      /* silent */
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    async function init(): Promise<void> {
      try {
        const res = await fetch("/api/data-sources");
        if (!cancelled && res.ok) {
          const data = (await res.json()) as DataSourceRow[];
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

  // Flat alphabetical list. Each row already shows its provider as
  // an inline chip after the name (DataSourceRowItem), so a separate
  // category section header would be redundant for our small list of
  // DB providers. If the catalog ever grows past a couple dozen
  // entries with mixed categories (HTTP / S3 / ...), revisit.
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
  }, [rows]);

  const isAdmin = currentUserRole === "admin";

  // Mutations (optimistic; revert on failure)

  async function handleToggleEnabled(row: DataSourceRow, enabled: boolean): Promise<void> {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      const res = await fetch(`/api/data-sources/${row.id}`, {
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
    row: DataSourceRow,
    visibility: "private" | "public",
  ): Promise<void> {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, visibility } : r)));
    try {
      const res = await fetch(`/api/data-sources/${row.id}`, {
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

  // Render

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Database className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Data Sources</h2>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => router.push("/datasource/new")}
            aria-label="New data source"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh data sources"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No data sources yet.{" "}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => router.push("/datasource/new")}
            >
              Create one
            </button>
          </div>
        ) : (
          <div>
            {sortedRows.map((row) => (
              <DataSourceRowItem
                key={row.id}
                row={row}
                active={row.id === activeDataSourceId}
                isOwner={row.createdBy === currentUserId}
                isAdmin={isAdmin}
                onEdit={(r) => router.push(`/datasource/${r.id}`)}
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
