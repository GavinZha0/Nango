"use client";

/**
 * SkillsPanel — full skill management panel in the left sidebar.
 *
 * Layout mirrors AgentPanel: two top-level tabs (Builtin / Custom)
 * replace the old collapsible-section grouping. Tab choice is
 * persisted across panel opens; the toolbar (+ / Import / Refresh)
 * shares the tab strip row to save vertical space.
 *
 * NB: the right-hand tab is intentionally called "Custom" here, not
 * "External" as in AgentPanel. The semantics differ: Agent's
 * "External" agents come from a foreign runtime (agno / mastra /
 * dify) — genuinely external systems. Skills tagged "non-builtin"
 * are user-authored inside Nango (via the editor) or imported from
 * a `.skill` archive; there's no external system involved, so
 * "Custom" reflects the user-centric reality better.
 */

import {
  RefreshCw,
  Plus,
  FolderUp,
  Globe,
  Lock,
  CircleCheck,
  CircleSlash,
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
import { useStoredValue } from "@/hooks/useStoredValue";

// localStorage key — namespaced so SkillsPanel's tab state stays
// independent of AgentPanel's (you can be on Builtin in Skills while
// External in Agents). Reads happen via `useStoredValue` for an
// SSR-safe hydration; writes go through the hook's returned setter
// so same-tab subscribers re-snapshot immediately.
const LS_KEY_TAB = "skills-panel-tab";

/** Two-tab split: built-in skills (seeded from `skills/` on disk and
 *  reconciled into DB at boot) vs custom skills (user-authored via
 *  the editor or imported from a `.skill` archive). Persisted across
 *  panel opens so power users land on their preferred view. */
type SkillsPanelTab = "builtin" | "custom";

function parseTab(raw: string | null): SkillsPanelTab {
  return raw === "custom" ? "custom" : "builtin";
}

// Types

interface SkillRow {
  id: string;
  path: string;
  name: string;
  description: string | null;
  source: "builtin" | "local";
  enabled: boolean;
  visibility: "private" | "public" | string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// Tab button — visual + accessibility behaviour identical to
// AgentPanel's TabButton; lifted here verbatim to avoid a shared util
// drag that no other panel would consume yet.
interface TabButtonProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, count, active, onClick }: TabButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
      aria-pressed={active}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] leading-none",
          active ? "bg-primary/20 text-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

// Skill row

interface SkillRowProps {
  row: SkillRow;
  /** True when the current route is /skills/<row.id>. Drives the
   *  selected-row highlight so users see which item the main panel
   *  is showing. Mirrors McpPanel's active row pattern. */
  active: boolean;
  isOwner: boolean;
  isAdmin: boolean;
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
    source: row.source || "local",
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
  // the user is mid-creation. Matched against `row.id` regardless
  // of source — the SkillEditor renders builtin skills read-only
  // but they're still routable, so the active highlight should fire.
  const skillsMatch = pathname.match(/^\/skills\/([^/]+)/);
  const activeSkillId =
    skillsMatch && skillsMatch[1] !== "new" ? skillsMatch[1] : null;

  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [importing, setImporting] = useState<boolean>(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [currentUserRole, setCurrentUserRole] = useState<string>("user");
  const importInputRef = useRef<HTMLInputElement>(null);

  // Active tab — persisted in localStorage via `useStoredValue` so
  // SSR sees `"builtin"` (the safe default) and the stored value
  // flows in on the first post-hydration render. Calling
  // `writeActiveTab(tab)` writes to localStorage AND notifies same-
  // tab subscribers, so the visual update is immediate.
  const { value: activeTab, write: writeActiveTab } =
    useStoredValue<SkillsPanelTab>({
      key: LS_KEY_TAB,
      parse: parseTab,
      serialize: (tab) => tab,
      serverDefault: "builtin",
    });
  function selectTab(tab: SkillsPanelTab): void {
    writeActiveTab(tab);
  }

  // Fetch current user.
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

  // Group rows. `custom` covers anything not seeded from disk
  // (source !== "builtin" — i.e. user-authored via the editor or
  // imported from a `.skill` archive).
  const { builtin, custom } = useMemo(() => {
    const cmp = (a: SkillRow, b: SkillRow) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return {
      builtin: skills.filter((s) => s.source === "builtin").sort(cmp),
      custom: skills.filter((s) => s.source !== "builtin").sort(cmp),
    };
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
      {/* Header — tab strip + global actions on a single row. The tab
          labels (Builtin / Custom) already identify this as the
          skills panel, so we don't repeat a "Skills" title. */}
      <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
        <TabButton
          label="Builtin"
          count={builtin.length}
          active={activeTab === "builtin"}
          onClick={() => selectTab("builtin")}
        />
        <TabButton
          label="Custom"
          count={custom.length}
          active={activeTab === "custom"}
          onClick={() => selectTab("custom")}
        />
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
        ) : activeTab === "builtin" ? (
          // ── Builtin tab: flat list ──────────────────────────────
          builtin.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No built-in skills available.
            </div>
          ) : (
            builtin.map((row) => (
              <SkillItem
                key={row.id}
                row={row}
                active={row.id === activeSkillId}
                isOwner={row.createdBy === currentUserId}
                isAdmin={currentUserRole === "admin"}
                onEdit={(r) => router.push(`/skills/${r.id}`)}
                onToggleEnabled={handleToggleEnabled}
                onToggleVisibility={handleToggleVisibility}
              />
            ))
          )
        ) : (
          // ── Custom tab: flat list of user-authored / imported ──
          custom.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No custom skills yet.{" "}
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
            custom.map((row) => (
              <SkillItem
                key={row.id}
                row={row}
                active={row.id === activeSkillId}
                isOwner={row.createdBy === currentUserId}
                isAdmin={currentUserRole === "admin"}
                onEdit={(r) => router.push(`/skills/${r.id}`)}
                onToggleEnabled={handleToggleEnabled}
                onToggleVisibility={handleToggleVisibility}
              />
            ))
          )
        )}
      </ScrollArea>
    </div>
  );
}
