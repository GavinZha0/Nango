"use client";

/**
 * SkillsPanel — full skill management panel in the left sidebar.
 *
 * One flat, name-sorted list of every skill the session can see. The
 * toolbar (+ / Import / Refresh) shares the header row to save vertical
 * space.
 */

import {
  RefreshCw,
  Plus,
  FolderUp,
  Globe,
  Lock,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import {
  type ReactNode,
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";

// Types

interface SkillRow {
  id: string;
  path: string;
  name: string;
  description: string | null;
  /** Free-form origin label (e.g. "anthropic", "skills.sh"); "" = unlabeled. */
  source: string;
  enabled: boolean;
  visibility: "private" | "public" | string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// Skill row

interface SkillRowProps {
  row: SkillRow;
  /** True when the current route is /skills/<row.id>. Drives the
   *  selected-row highlight so users see which item the main panel
   *  is showing. Mirrors McpPanel's active row pattern. */
  active: boolean;
  onEdit: (row: SkillRow) => void;
  onToggleEnabled: (row: SkillRow, next: boolean) => void;
  onToggleVisibility: (row: SkillRow, next: "private" | "public") => void;
}

/**
 * One skill in the panel list.
 *
 * Layout matches the AgentPanel BuiltinRow update from the previous
 * sweep: identity (name) is left-aligned and takes flex-1; metadata
 * controls (visibility, enabled toggle) are right-aligned and packed.
 *
 * Delete is intentionally NOT exposed here — destructive actions live
 * inside the editor (next to Save) to keep accidental clicks out of
 * scrolling lists. Same rationale as AgentPanel's BuiltinRow.
 */
function SkillItem({
  row,
  active,
  onEdit,
  onToggleEnabled,
  onToggleVisibility,
}: SkillRowProps): ReactNode {
  const isPublic: boolean = row.visibility === "public";

  const { canEdit, canChangeVisibility } = useResourcePermissions({
    visibility: row.visibility as "private" | "public",
    createdBy: row.createdBy,
  });

  const canToggleEnabled: boolean = canChangeVisibility;
  const canToggleVisibility: boolean = canChangeVisibility;

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 last:border-0 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        {/* Left cluster: name (click to view/edit) */}
        <div className="flex flex-1 min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onEdit(row)}
            className="cursor-pointer truncate text-left text-base font-medium hover:underline underline-offset-2"
            aria-label={canEdit ? `Edit ${row.name}` : `View ${row.name}`}
          >
            {row.name}
          </button>
        </div>

        {/* Right cluster: visibility + enabled — sit together so all
            of the row's metadata icons live in one spot, matching
            AgentPanel's BuiltinRow layout. */}
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
              aria-label={isPublic ? "Public skill" : "Private skill"}
            >
              {isPublic ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            </span>
          )}

          {canToggleEnabled ? (
            <button
              type="button"
              onClick={() => onToggleEnabled(row, !row.enabled)}
              className="cursor-pointer rounded p-0.5 hover:text-foreground"
              aria-label={row.enabled ? "Disable skill" : "Enable skill"}
            >
              {row.enabled ? (
                <ToggleRight className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <ToggleLeft className="h-3.5 w-3.5 text-muted-foreground/40" />
              )}
            </button>
          ) : (
            <span className="p-0.5">
              {row.enabled ? (
                <ToggleRight className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <ToggleLeft className="h-3.5 w-3.5 text-muted-foreground/40" />
              )}
            </span>
          )}
        </div>
      </div>

      {row.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {row.description}
        </p>
      )}
    </div>
  );
}

// Main component

export function SkillsPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();

  // Active row id: derived from /skills/<id>. `new` is a sentinel
  // (the create page); skipping it keeps the highlight off when
  // the user is mid-creation.
  const skillsMatch = pathname.match(/^\/skills\/([^/]+)/);
  const activeSkillId =
    skillsMatch && skillsMatch[1] !== "new" ? skillsMatch[1] : null;

  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [importing, setImporting] = useState<boolean>(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Refresh on demand — used by the toolbar button and after admin sync.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/skills");
      if (res.ok) {
        const data = (await res.json()) as SkillRow[];
        setSkills(data);
      }
    } catch {
      /* silent */
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  // Initial load — done inline in the effect rather than via `refresh()`
  // to avoid the react-hooks/set-state-in-effect rule trip-wire that
  // fires when an effect synchronously calls a function that flips state.
  useEffect(() => {
    let cancelled = false;
    async function init(): Promise<void> {
      try {
        const res = await fetch("/api/skills");
        if (!cancelled && res.ok) {
          const data = (await res.json()) as SkillRow[];
          setSkills(data);
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

  // One flat, name-sorted list: the source column is a user label, not a
  // taxonomy.
  const sortedSkills: SkillRow[] = useMemo(() => {
    const cmp = (a: SkillRow, b: SkillRow) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return [...skills].sort(cmp);
  }, [skills]);

  // Mutations
  async function handleToggleEnabled(row: SkillRow, enabled: boolean): Promise<void> {
    setSkills((prev) => prev.map((s) => (s.id === row.id ? { ...s, enabled } : s)));
    try {
      await fetch(`/api/skills/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      setSkills((prev) =>
        prev.map((s) => (s.id === row.id ? { ...s, enabled: !enabled } : s)),
      );
    }
  }

  async function handleToggleVisibility(
    row: SkillRow,
    visibility: "private" | "public",
  ): Promise<void> {
    setSkills((prev) => prev.map((s) => (s.id === row.id ? { ...s, visibility } : s)));
    try {
      await fetch(`/api/skills/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
    } catch {
      setSkills((prev) =>
        prev.map((s) => (s.id === row.id ? { ...s, visibility: row.visibility } : s)),
      );
    }
  }

  async function handleImportFile(file: File): Promise<void> {
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/skills/import", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        alert(body.message ?? `Import failed (${res.status})`);
        return;
      }
      const created = (await res.json()) as { id: string };
      await refresh();
      router.push(`/skills/${created.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  // Render
  return (
    <div className="flex h-full flex-col">
      {/* Header — panel identity + global actions on a single row. */}
      <div className="flex items-center border-b bg-muted/40 px-3 py-1.5">
        <span className="text-sm font-medium">Skills</span>
        <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          {skills.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => router.push("/skills/new")}
            aria-label="New skill"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            aria-label="Import .skill archive"
          >
            <FolderUp className={cn("h-3.5 w-3.5", importing && "animate-pulse")} />
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="*/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportFile(f);
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh skills"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : sortedSkills.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">
            No skills yet.{" "}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => router.push("/skills/new")}
            >
              Create one
            </button>{" "}
            or import a <code>.skill</code> archive.
          </div>
        ) : (
          sortedSkills.map((row) => (
            <SkillItem
              key={row.id}
              row={row}
              active={row.id === activeSkillId}
              onEdit={(r) => router.push(`/skills/${r.id}`)}
              onToggleEnabled={handleToggleEnabled}
              onToggleVisibility={handleToggleVisibility}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
