"use client";

/**
 * AgentPanel — full agent management panel in the left sidebar.
 */

import {
  Users,
  Workflow as WorkflowIcon,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Plus,
  Globe,
  Lock,
  CircleCheck,
  CircleSlash,
  Star,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { agentKey, getEntities } from "@/lib/backends/facade";
import type { BackendId } from "@/lib/backends/facade";
import type { EntityKind, EntityFetchError } from "@/lib/backends/types";
import { useWorkspaceStore } from "@/store/workspace";
import { cn } from "@/lib/utils";
import { alphabeticCompare } from "@/lib/utils/sort";
import { useStoredValue } from "@/hooks/useStoredValue";
import { useRouter, usePathname } from "next/navigation";
import type { BuiltinAgentRow } from "@/lib/types/builtin-agent";
import { resolveAgentIcon } from "@/components/ui/emoji-picker";
import { useResourcePermissions } from "@/hooks/useResourcePermissions";

// localStorage keys + parse/serialize helpers — values are read via
// `useStoredValue` for an SSR-safe hydration (server snapshot is the
// natural default; localStorage flows in post-hydration).

const LS_KEY_DISABLED_BACKEND = "agent-panel-disabled-backend";
const LS_KEY_TAB = "agent-panel-tab";

/** Stable empty-set reference for the SSR snapshot. `useStoredValue`
 *  needs a single object identity per render to avoid spurious tearing
 *  detection inside `useSyncExternalStore`. A frozen module-level Set
 *  works because callers never mutate it (`toggleBackendDisabled`
 *  always allocates a new Set via `new Set(prev)`). */
const SSR_EMPTY_SET: Set<string> = Object.freeze(new Set<string>()) as Set<string>;

function parseDisabledSet(raw: string | null): Set<string> {
  if (!raw) return SSR_EMPTY_SET;
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return SSR_EMPTY_SET;
  }
}

function serializeDisabledSet(ids: Set<string>): string {
  return JSON.stringify([...ids]);
}

/** Two-tab split: built-in agents (DB-stored, includes supervisor) vs
 *  external agents pulled from backend runtimes (Agno / Mastra / Dify).
 *  Persisted across panel opens so users who primarily live in one tab
 *  don't have to click back every time. */
type AgentPanelTab = "builtin" | "external";

function parseTab(raw: string | null): AgentPanelTab {
  return raw === "external" ? "external" : "builtin";
}

type VisibilityValue = "private" | "public";

// Badge helpers

const CHIP = "rounded-sm px-1 py-0.5 text-[10px] leading-none font-mono";

function ModelChip({ modelId }: { modelId?: string }) {
  if (!modelId) return null;
  const label = modelId.length > 12 ? `${modelId.slice(0, 11)}…` : modelId;
  return (
    <span className="font-mono text-[11px] text-foreground/70">{label}</span>
  );
}

// Tab button — matches the MCP test page tab style for visual
// consistency. Active tab gets a primary-colored bottom border and full
// foreground; inactive shows muted text + transparent border that turns
// into the foreground color on hover.
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

// Section header (div, mirrors MCP panel pattern)

type SectionTone = "normal" | "warn" | "error";

interface SectionHeaderProps {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  tone?: SectionTone;
}

function SectionHeader({ label, count, open, onToggle, action, tone = "normal" }: SectionHeaderProps) {
  const failed = tone === "error";
  const warn = tone === "warn";
  return (
    <div className="flex items-center gap-1 border-t border-border/60 first:border-t-0 bg-muted/40 px-2 py-1.5">
      <button
        type="button"
        className="cursor-pointer flex flex-1 items-center gap-1 text-left"
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("text-xs font-semibold uppercase tracking-wider", failed ? "text-destructive" : warn ? "text-warning" : "text-muted-foreground")}>
          {label}
        </span>
        <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          {count}
        </span>
      </button>
      {action}
    </div>
  );
}

function formatFetchError(e: EntityFetchError) {
  const status = e.status ? `(${e.status})` : "";
  const source = e.source ? `(${e.source})` : "";
  return `${e.message} ${status} ${source}`;
}

// Backend agent row (agno / Mastra)

interface BackendRowProps {
  id: string;
  name: string;
  subtitle?: string;
  modelId?: string;
  toolCount?: number;
  memberCount?: number;
  /**
   * Optional version label shown as a `v1` chip next to the name.
   * Only populated by adapters whose upstream tracks versions (agno
   * workflows today); other backends leave it undefined and no chip
   * renders. See `EntityDescriptor.version` for the source and
   * `docs/a2a-compatibility.md` for the wider A2A mapping rationale.
   */
  version?: string;
  /** Kind of entity — drives the inline badge ("team" / "workflow") and
   *  the placeholder shown for not-yet-implemented kinds. */
  kind: EntityKind;
  disabled: boolean;
  /** True when the current route is the detail page for this external
   *  agent (/agent/external/<credentialId>/<id>). Drives the selected
   *  row highlight; same mechanism as McpPanel / SkillsPanel. */
  active: boolean;
  onToggleDisabled: (id: string, next: boolean) => void;
  /** Click handler for the row's name — navigates to the read-only
   *  detail page. Optional so the row keeps working in contexts
   *  where the detail page isn't wired up yet. */
  onOpenDetail?: () => void;
}

function BackendRow({
  id,
  name,
  subtitle,
  modelId,
  memberCount,
  version,
  kind,
  disabled,
  active,
  onToggleDisabled,
  onOpenDetail,
}: BackendRowProps) {
  // Two-line layout matching McpPanel
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        disabled && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="flex flex-1 min-w-0 items-center gap-1">
          {onOpenDetail ? (
            <button
              type="button"
              className="cursor-pointer truncate text-left text-base font-medium hover:underline hover:underline-offset-2"
              onClick={onOpenDetail}
              aria-label={`Open ${name} details`}
            >
              {name}
            </button>
          ) : (
            <span className="truncate text-base font-medium">{name}</span>
          )}
          {kind === "team" && (memberCount ?? 0) > 0 && (
            <span
              className={cn(CHIP, "flex shrink-0 items-center gap-0.5 bg-muted text-foreground/70")}
            >
              <Users className="h-2.5 w-2.5" />
              {memberCount}
            </span>
          )}
          {kind === "workflow" && (
            <span
              className={cn(CHIP, "flex shrink-0 items-center gap-0.5 bg-muted text-foreground/70")}
              title="Workflow — chat is not yet supported"
            >
              <WorkflowIcon className="h-2.5 w-2.5" />
              wf
            </span>
          )}
          {/* Version chip — same visual treatment as the MCP panel's
              `v{version}` label so users see the same metadata in the
              same place across the two left panels. */}
          {version && (
            <span className="text-xs font-normal text-muted-foreground/60 shrink-0">
              v{version}
            </span>
          )}
        </div>
        <ModelChip modelId={modelId} />
        <button
          type="button"
          onClick={() => onToggleDisabled(id, !disabled)}
          className="cursor-pointer shrink-0 rounded p-0.5 hover:text-foreground"
          aria-label={disabled ? "Enable agent" : "Disable agent"}
        >
          {disabled
            ? <CircleSlash className="h-3.5 w-3.5 text-foreground/70" />
            : <CircleCheck className="h-3.5 w-3.5 text-green-400/50" />
          }
        </button>
      </div>
      {subtitle && (
        <span className="truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      )}
    </div>
  );
}

// BuiltIn agent row

interface BuiltinRowProps {
  row: BuiltinAgentRow;
  currentUserId: string;
  /** True when the current route is /agent/<row.id>. Drives the
   *  selected-row highlight, matching McpPanel / SkillsPanel. */
  active: boolean;
  onEdit: (row: BuiltinAgentRow) => void;
  onToggleVisibility: (row: BuiltinAgentRow, next: VisibilityValue) => void;
  onToggleEnabled: (row: BuiltinAgentRow, next: boolean) => void;
}

/**
 * BuiltinRow — one row in the Builtin agents list.
 *
 * Two-line layout:
 *   Line 1: [icon] [name] [⭐ supervisor?] ............... [model] [vis] [on/off]
 *           ←─── left-aligned identity ───→     ←──── right-aligned metadata ───→
 *   Line 2: description (truncated, muted)
 *
 * Delete is intentionally NOT shown here. Deletion is a low-frequency,
 * destructive action — burying it inside the editor (next to Save)
 * prevents accidental clicks from the list and keeps the row visually
 * clean.
 */
function BuiltinRow({
  row,
  currentUserId,
  active,
  onEdit,
  onToggleVisibility,
  onToggleEnabled,
}: BuiltinRowProps) {
  const isOwner = row.createdBy === currentUserId;
  const isPublic = row.visibility === "public";

  const { canChangeVisibility } = useResourcePermissions({
    source: "local" as const,
    visibility: row.visibility as "private" | "public",
    createdBy: row.createdBy,
  });

  const subtitle = row.description ?? row.prompt ?? null;
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border/70 px-3 py-2 transition-colors",
        active ? "bg-accent" : "hover:bg-muted/30",
        !row.enabled && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        {/* ── Left cluster: identity (icon + name + supervisor flag) ── */}
        <div className="flex flex-1 min-w-0 items-center gap-2">
          {/* Agent icon — user-chosen emoji or default 🤖. Drawn via the
              native emoji font (no CDN), fallback chain matches the
              EmojiPicker for visual consistency. `text-xl` (20 px)
              mirrors the editor's picker trigger and renders noticeably
              larger than the surrounding `text-base` name so the glyph
              acts as the row's primary visual anchor. */}
          <span
            aria-hidden
            className="flex shrink-0 items-center justify-center rounded-md bg-card dark:bg-white border border-border text-xl leading-none"
            style={{
              width: "32px",
              height: "32px",
              fontFamily:
                '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", system-ui, sans-serif',
            }}
          >
            {resolveAgentIcon(row.icon)}
          </span>

          {/* Name — click to edit for owner or public resources, plain span otherwise. */}
          {isOwner || isPublic ? (
            <button
              type="button"
              className="cursor-pointer truncate text-left text-base font-medium hover:underline hover:underline-offset-2"
              onClick={() => onEdit(row)}
              aria-label={`Edit ${row.name}`}
            >
              {row.name}
            </button>
          ) : (
            <span className="truncate text-base font-medium">{row.name}</span>
          )}

          {/* Supervisor flag — pinned next to the name so the user's
              main entry point stays visually distinct in the flat list. */}
          {row.role === "supervisor" && (
            <Star
              className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400"
              aria-label="Supervisor (Nango)"
            />
          )}
        </div>

        {/* ── Right cluster: model + visibility + enabled toggle ── */}
        <div className="flex shrink-0 items-center gap-2">
          <ModelChip modelId={row.model} />

          {/* Visibility — public/private. Click toggles for owner or admin. */}
          {canChangeVisibility ? (
            <button
              type="button"
              onClick={() => onToggleVisibility(row, isPublic ? "private" : "public")}
              className="cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
              aria-label={isPublic ? "Set to private" : "Set to public"}
            >
              {isPublic
                ? <Globe className="h-3.5 w-3.5" />
                : <Lock className="h-3.5 w-3.5" />
              }
            </button>
          ) : (
            <span
              className="p-0.5 text-muted-foreground/70"
              aria-label={isPublic ? "Public agent" : "Private agent"}
            >
              {isPublic
                ? <Globe className="h-3.5 w-3.5" />
                : <Lock className="h-3.5 w-3.5" />
              }
            </span>
          )}

          {/* Enabled / disabled — click toggles for owner or admin. */}
          {canChangeVisibility ? (
            <button
              type="button"
              onClick={() => onToggleEnabled(row, !row.enabled)}
              className="cursor-pointer rounded p-0.5 hover:text-foreground"
              aria-label={row.enabled ? "Disable agent" : "Enable agent"}
            >
              {row.enabled
                ? <CircleCheck className="h-3.5 w-3.5 text-green-400/50" />
                : <CircleSlash className="h-3.5 w-3.5 text-foreground/70" />
              }
            </button>
          ) : (
            <span className="p-0.5">
              {row.enabled
                ? <CircleCheck className="h-3.5 w-3.5 text-green-400/50" />
                : <CircleSlash className="h-3.5 w-3.5" />
              }
            </span>
          )}
        </div>
      </div>
      {subtitle && (
        <span className="truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      )}
    </div>
  );
}

// Main component

export function AgentPanel(): ReactNode {
  const {
    agents,
    teams,
    workflows,
    builtinAgents,
    backendCredentials,
    agentsLoaded,
    mergeBuiltinAgents,
    replaceEntitiesForCredentials,
    replaceBackendCredentialsFor,
  } = useWorkspaceStore();
  /** Set of credentialIds currently being refreshed. Multiple groups can
   *  spin independently. A group's spinner / disabled state is derived
   *  by checking whether any of its credentialIds is in this set. */
  const [refreshingCredIds, setRefreshingCredIds] = useState<Set<string>>(new Set());

  // Backend disabled set (localStorage). Read via `useStoredValue`
  // so SSR returns the empty set (default) and the stored value
  // flows in post-hydration without a setState-in-effect. The shared
  // SSR_EMPTY_SET reference prevents server/client snapshot churn
  // when nothing is stored. Writes go through `writeBackendDisabled`
  // which also notifies RightPanel's mirror via the same-tab event.
  const { value: backendDisabled, write: writeBackendDisabled } =
    useStoredValue<Set<string>>({
      key: LS_KEY_DISABLED_BACKEND,
      parse: parseDisabledSet,
      serialize: serializeDisabledSet,
      serverDefault: SSR_EMPTY_SET,
    });

  function toggleBackendDisabled(id: string, disable: boolean) {
    const next = new Set(backendDisabled);
    if (disable) next.add(id); else next.delete(id);
    writeBackendDisabled(next);
  }

  // BuiltIn agents (from store, loaded by WorkspaceProvider)
  const builtinLoaded = agentsLoaded;
  const [builtinRefreshing, setBuiltinRefreshing] = useState(false);

  // Edit view — navigate to route
  const router = useRouter();
  const pathname = usePathname();

  // Active row id derivation. Two routes flow into this panel:
  //   /agent/<id>                             → builtin
  //   /agent/external/<credentialId>/<id>     → external (BackendRow)
  // The `new` sentinel for the create page is filtered out so the
  // highlight doesn't fire mid-creation. The external regex captures
  // both halves of the compound key so BackendRow can match against
  // its `(credentialId, id)` pair without ambiguity.
  const builtinMatch = pathname.match(/^\/agent\/([^/]+)$/);
  const activeBuiltinId =
    builtinMatch &&
    builtinMatch[1] !== "new" &&
    builtinMatch[1] !== "external"
      ? builtinMatch[1]
      : null;

  const externalMatch = pathname.match(/^\/agent\/external\/([^/]+)\/([^/]+)/);
  const activeExternal = externalMatch
    ? {
        credentialId: decodeURIComponent(externalMatch[1]),
        id: decodeURIComponent(externalMatch[2]),
      }
    : null;

  // Section collapse state (external tab only — builtin tab is flat).
  // Local collapse state; starts collapsed.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  function toggleSection(key: string) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Active tab — persisted in localStorage via `useStoredValue` so
  // SSR sees `"builtin"` (the safe default) and the stored value
  // flows in on the first post-hydration render. Same hydration
  // contract as SkillsPanel; see `useStoredValue` for the mechanics.
  const { value: activeTab, write: writeActiveTab } =
    useStoredValue<AgentPanelTab>({
      key: LS_KEY_TAB,
      parse: parseTab,
      serialize: (tab) => tab,
      serverDefault: "builtin",
    });
  function selectTab(tab: AgentPanelTab) {
    writeActiveTab(tab);
  }

  // Current user id
  // We read it from the workspace store (set by WorkspaceProvider from email local-part).
  // For ownership checks we need the DB user id — fetch it separately.
  const [currentUserId, setCurrentUserId] = useState<string>("");

  useEffect(() => {
    async function fetchUserId() {
      try {
        const res = await fetch("/api/auth/get-session");
        if (res.ok) {
          const data = await res.json() as { user?: { id?: string } };
          setCurrentUserId(data?.user?.id ?? "");
        }
      } catch { /* silent */ }
    }
    void fetchUserId();
  }, []);

  // Per-group backend refresh
  // Refreshes slice of entities belonging to the given credentials in parallel.
  const loadBackendCredentials = useCallback(
    async (creds: { credentialId: string }[]) => {
      if (creds.length === 0) return;
      const credIdSet = new Set(creds.map((c) => c.credentialId));

      setRefreshingCredIds((prev) => {
        const next = new Set(prev);
        for (const id of credIdSet) next.add(id);
        return next;
      });

      // User-initiated refresh: bypass server cache.
      const result = await getEntities(creds, { force: true });
      const loaded = result.data ?? [];
      // Replace across all kinds.
      replaceEntitiesForCredentials(credIdSet, loaded);

      if (result.credentials.length > 0) {
        replaceBackendCredentialsFor(credIdSet, result.credentials);
      }

      setRefreshingCredIds((prev) => {
        const next = new Set(prev);
        for (const id of credIdSet) next.delete(id);
        return next;
      });
    },
    [replaceEntitiesForCredentials, replaceBackendCredentialsFor],
  );

  // Refresh BuiltIn agents (manual refresh button)
  const loadBuiltin = useCallback(async () => {
    setBuiltinRefreshing(true);
    try {
      const res = await fetch("/api/builtin-agents");
      if (res.ok) {
        const data = await res.json() as BuiltinAgentRow[];
        mergeBuiltinAgents(data);
      }
    } catch { /* silent */ }
    setBuiltinRefreshing(false);
  }, [mergeBuiltinAgents]);

  /** Initial-load spinner: shown only until WorkspaceProvider has
   *  populated the store for the first time. After that the per-group
   *  buttons own their own spinners via refreshingCredIds. */
  const loading = !agentsLoaded;

  // Backend entries grouped by credential name
  interface BackendEntry {
    id: string;
    name: string;
    subtitle?: string;
    modelId?: string;
    toolCount?: number;
    /** EntityDescriptor.kind — drives row-level icon / badge rendering. */
    kind: EntityKind;
    memberCount?: number;
    /** Optional upstream version, forwarded into BackendRow for the
     *  `v{version}` chip. Only populated by adapters whose upstream
     *  tracks versions (agno workflows today). */
    version?: string;
    credentialId?: string;
    credentialName: string;
    /** Provider slug; needed when this group's refresh button must call
     *  the right adapter via the backend façade. */
    provider?: BackendId;
  }

  interface BackendGroup {
    credentialName: string;
    entries: BackendEntry[];
    creds: { credentialId: string }[];
    errors: EntityFetchError[];
    ok: boolean;
  }

  const backendGroups = useMemo<BackendGroup[]>(() => {
    const entriesByCred = new Map<string, BackendEntry[]>();
    const indexEntry = (e: BackendEntry): void => {
      if (!e.credentialName) return;
      const list = entriesByCred.get(e.credentialName);
      if (list) list.push(e);
      else entriesByCred.set(e.credentialName, [e]);
    };
    for (const a of agents) {
        indexEntry({
        id: a.id,
        name: a.name ?? a.id,
        subtitle: a.description,
        modelId: a.model?.id,
        toolCount: a.toolCount,
        kind: "agent",
        version: a.version,
        credentialId: a.credentialId,
        credentialName: a.credentialName ?? "Backend",
        provider: a.provider,
      });
    }
    for (const t of teams) {
      indexEntry({
      id: t.id,
      name: t.name ?? t.id,
      subtitle: t.description,
      modelId: t.model?.id,
      toolCount: t.toolCount,
      kind: "team",
      memberCount: t.memberCount,
      version: t.version,
      credentialId: t.credentialId,
      credentialName: t.credentialName ?? "Backend",
      provider: t.provider,
      })
    }
    // Workflows render as placeholders until orchestrated.
    for (const w of workflows) {
      indexEntry({
      id: w.id,
      name: w.name ?? w.id,
      subtitle: w.description,
      kind: "workflow",
      version: w.version,
      credentialId: w.credentialId,
      credentialName: w.credentialName ?? "Backend",
      provider: w.provider,
      });
    }

    // Group by credentialName
    const groupMap = new Map<string, BackendGroup>();
    for (const cred of backendCredentials) {
      let group = groupMap.get(cred.name)
      if (!group) {
        group = {credentialName: cred.name, entries: [], creds: [], errors: [], ok: true };
        groupMap.set(cred.name, group);
      }
      group.entries.push(...(entriesByCred.get(cred.name) ?? []))
      group.creds.push({credentialId: cred.credentialId });
      if(!cred.ok) {
        group.ok = false;
        group.errors.push(...(cred.errors));
      }
    }

    const groups = Array.from(groupMap.values());
    for(const group of groups) {
      group.entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
      );
    }

    return groups.sort((a, b) =>
      a.credentialName.localeCompare(b.credentialName, undefined, { sensitivity: "base" })
    );
  }, [agents, teams, workflows, backendCredentials]);

  // Purely alphabetical by name.
  const sortedBuiltinAgents = useMemo(
    () =>
      [...builtinAgents].sort((a, b) => alphabeticCompare(a.name, b.name)),
    [builtinAgents]
  );

  // BuiltIn: toggle enabled (DB)
  async function handleBuiltinToggle(row: BuiltinAgentRow, enabled: boolean) {
    mergeBuiltinAgents(builtinAgents.map((a) => (a.id === row.id ? { ...a, enabled } : a)));
    try {
      await fetch(`/api/builtin-agents/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      mergeBuiltinAgents(builtinAgents.map((a) => (a.id === row.id ? { ...a, enabled: !enabled } : a)));
    }
  }

  // BuiltIn: toggle visibility (DB)
  async function handleBuiltinVisibility(row: BuiltinAgentRow, visibility: VisibilityValue) {
    const previousVisibility = row.visibility;
    mergeBuiltinAgents(builtinAgents.map((a) => (a.id === row.id ? { ...a, visibility } : a)));

    try {
      const res = await fetch(`/api/builtin-agents/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });

      if (!res.ok) {
        throw new Error("Failed to update visibility");
      }
    } catch {
      mergeBuiltinAgents(builtinAgents.map((a) => (a.id === row.id ? { ...a, visibility: previousVisibility } : a)));
    }
  }

  // BuiltIn: open inline editor
  function handleEdit(row: BuiltinAgentRow) {
    router.push(`/agent/${row.id}`);
  }

  function handleNewAgent() {
    router.push("/agent/new");
  }

  // Refreshes BuiltIn agents and backend groups in parallel.
  const refreshAll = useCallback(() => {
    void loadBuiltin();
    for (const g of backendGroups) {
      if (g.creds.length > 0) void loadBackendCredentials(g.creds);
    }
  }, [loadBuiltin, loadBackendCredentials, backendGroups]);

  // Drives the header refresh icon's spin state.
  const anyRefreshing: boolean =
    builtinRefreshing || refreshingCredIds.size > 0;

  // Totals for tab badges. External counts entries across all backend
  // groups (a single conceptual "external pool" from the user's POV
  // even though it's grouped by credential underneath).
  const externalTotal: number = backendGroups.reduce(
    (sum, g) => sum + g.entries.length,
    0,
  );

  return (
      <div className="flex h-full flex-col">
        {/* Header — tab strip + global actions on a single row. The tab
            labels (Builtin / External) already communicate "this is the
            agent panel", so we don't repeat a redundant "Agents" title.
            Tabs follow the MCP test page's bottom-border style; the
            +/refresh actions are pushed to the right with `ml-auto` and
            kept centered vertically against the taller tab cells. */}
        <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
          <TabButton
            label="Builtin"
            count={sortedBuiltinAgents.length}
            active={activeTab === "builtin"}
            onClick={() => selectTab("builtin")}
          />
          <TabButton
            label="External"
            count={externalTotal}
            active={activeTab === "external"}
            onClick={() => selectTab("external")}
          />
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleNewAgent}
              aria-label="New BuiltIn agent"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={refreshAll}
              disabled={anyRefreshing}
              aria-label="Refresh agents"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", anyRefreshing && "animate-spin")} />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div>
            {activeTab === "builtin" ? (
              // ── Builtin: flat list, no folding ─────────────────────
              !builtinLoaded ? (
                <div className="px-4 py-3 text-xs text-muted-foreground">
                  Loading…
                </div>
              ) : sortedBuiltinAgents.length === 0 ? (
                <div className="px-4 py-3 text-xs text-muted-foreground">
                  No BuiltIn agents yet.{" "}
                  <button
                    type="button"
                    className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                    onClick={handleNewAgent}
                  >
                    Create one
                  </button>
                </div>
              ) : (
                sortedBuiltinAgents.map((row) => (
                  <BuiltinRow
                    key={row.id}
                    row={row}
                    currentUserId={currentUserId}
                    active={row.id === activeBuiltinId}
                    onEdit={handleEdit}
                    onToggleVisibility={handleBuiltinVisibility}
                    onToggleEnabled={handleBuiltinToggle}
                  />
                ))
              )
            ) : (
              // ── External: grouped by credential, collapsed by default ──
              backendGroups.length === 0 ? (
                <div className="px-4 py-3 text-xs text-muted-foreground">
                  {loading
                    ? "Loading…"
                    : "No external backends. Add a credential with serviceType=\"agent\" first."}
                </div>
              ) : (
                backendGroups.map((backendGroup) => {
                  const sectionKey = `backend:${backendGroup.credentialName}`;
                  const isOpen = openSections.has(sectionKey);
                  const groupRefreshing = backendGroup.creds.some((c) =>
                    refreshingCredIds.has(c.credentialId),
                  );
                  const tone: SectionTone = backendGroup.ok ? "normal" : backendGroup.entries.length === 0 ? "error" : "warn";
                  return (
                    <Fragment key={sectionKey}>
                      <SectionHeader
                        label={backendGroup.credentialName}
                        count={backendGroup.entries.length}
                        open={isOpen}
                        onToggle={() => toggleSection(sectionKey)}
                        tone={tone}
                        action={
                          <button
                            type="button"
                            onClick={() =>
                              void loadBackendCredentials(backendGroup.creds)
                            }
                            disabled={groupRefreshing}
                            className="cursor-pointer rounded p-1 text-muted-foreground/60 hover:text-foreground disabled:opacity-50"
                            aria-label={`Refresh ${backendGroup.credentialName}`}
                          >
                            <RefreshCw className={cn("h-3 w-3", groupRefreshing && "animate-spin")} />
                          </button>
                        }
                      />

                      {isOpen && (
                        <Fragment>
                          {
                            backendGroup.errors.length > 0&& (
                              <div className="border-b border-border/60 px-4 py-2">
                                <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  Unavailable
                                </div>
                                <ul className="space-y-0.5">
                                  {backendGroup.errors.map((err, i) => (
                                    <li key={i} className="text-xs text-muted-foreground">
                                      {formatFetchError(err)}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )
                          }
                          {loading && backendGroup.entries.length === 0 ? (
                            <div className="px-4 py-2 text-xs text-muted-foreground">
                              Loading…
                            </div>
                          ) : backendGroup.entries.length === 0 ? (
                            backendGroup.errors.length === 0 ? (
                              <div className="px-4 py-2 text-xs text-muted-foreground">
                                No agents. Check that the backend is running.
                              </div>
                            ) : null
                          ) : (
                            backendGroup.entries.map((e) => {
                              const key = agentKey(e.credentialId, e.id);
                              // Detail route only exists when both
                              // identity halves are present (workflow
                              // placeholders without a credentialId
                              // fall through to a non-clickable name).
                              const detailHref: string | null =
                                e.credentialId
                                  ? `/agent/external/${encodeURIComponent(e.credentialId)}/${encodeURIComponent(e.id)}`
                                  : null;
                              const isActive =
                                activeExternal !== null &&
                                activeExternal.credentialId === e.credentialId &&
                                activeExternal.id === e.id;
                              return (
                                <BackendRow
                                  key={key}
                                  {...e}
                                  disabled={backendDisabled.has(key)}
                                  active={isActive}
                                  onToggleDisabled={(_id, next) =>
                                    toggleBackendDisabled(key, next)
                                  }
                                  onOpenDetail={
                                    detailHref
                                      ? () => router.push(detailHref)
                                      : undefined
                                  }
                                />
                              );
                            })
                          )}
                        </Fragment>
                      )}
                    </Fragment>
                  );
                })
              )
            )}
          </div>
        </ScrollArea>
      </div>
  );
}
