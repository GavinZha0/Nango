"use client";

/**
 * BuiltinAgentEditor — inline right-panel editor for a single BuiltIn agent.
 */

import {
  useState,
  useEffect,
  useCallback,
  startTransition,
  type ReactNode,
  type ChangeEvent,
} from "react";
import { ArrowLeft, Save, Loader2, ChevronDown, ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { EmojiPicker } from "@/components/ui/emoji-picker";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getProviderLabel } from "@/lib/constants/providers";
import { SUPERVISOR_PERSONA_SEED } from "@/lib/constants/supervisor";

// Shared row type (re-exported for other consumers)

export interface BuiltinAgentRow {
  id: string;
  /** True when this agent is the user's Nango. */
  isSupervisor?: boolean;
  /**
   * One-line persona surfaced to the supervisor's `list_agents`.
   * Optional — null until the user authors one in the editor.
   */
  role?: string | null;
  /**
   * Optional emoji glyph for visual identification (e.g. "🤖", "📊").
   * Stored as the raw Unicode character. NULL means "use the default
   * glyph chosen by the renderer" (see DEFAULT_AGENT_ICON).
   */
  icon?: string | null;
  name: string;
  description: string | null;
  model: string;
  modelProvider: string;
  credentialId: string | null;
  prompt: string | null;
  temperature: string | null;
  maxTokens: number | null;
  maxSteps: number | null;
  toolChoice: string;
  memoryEnabled: boolean;
  memoryWindowSize: number | null;
  enabled: boolean;
  visibility: string;
  createdBy: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  /** Total number of tool rows attached (non-skill). */
  toolCount?: number;
  /** Number of skill-type tool rows. */
  skillCount?: number;
}

// Types

export interface BoundToolRow {
  id?: string;
  toolType: string;
  mcpServerId?: string | null;
  mcpServerName?: string | null;
  sshServerId?: string | null;
  mcpToolName?: string | null;
  skillId?: string | null;
  skillName?: string | null;
  builtinTool?: string | null;
  dataSourceId?: string | null;
}

interface MpcServer { id: string; name: string; description: string | null; enabled: boolean }
interface Skill { id: string; name: string; description: string | null; source: string }
interface BuiltinToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  category: "data-source" | "sandbox";
}
interface LlmCredential { id: string; name: string; provider: string | null }

interface AgentDetail extends BuiltinAgentRow {
  tools: BoundToolRow[];
}

// Collapsible section

function Section({
  title,
  children,
  defaultOpen = true,
  count,
  actions,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Optional "(selected/total)" badge after the title. Omitted for
   *  non-selection sections (Basic / System Prompt / Knowledge Base
   *  placeholder). Reactive — re-renders as the parent's Sets change. */
  count?: { selected: number; total: number };
  /** Right-aligned action(s) on the title row (e.g. "Restore default"
   *  for System Prompt). Sits OUTSIDE the toggle button so clicking an
   *  action does not collapse/expand the section. */
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/40">
      <div className="flex items-center gap-1.5 px-4 py-2.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-1.5 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {count && (
            <span className="text-xs font-normal tabular-nums text-muted-foreground/70">
              ({count.selected}/{count.total})
            </span>
          )}
        </button>
        {actions}
      </div>
      {open && <div className="space-y-3 px-4 pb-3">{children}</div>}
    </div>
  );
}

// Multi-select checkbox list

function CheckList<T extends { id: string; name: string; description?: string | null }>({
  items,
  selected,
  onToggle,
  emptyText,
}: {
  items: T[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  emptyText: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <label
          key={item.id}
          className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1 hover:bg-muted/40"
        >
          <Checkbox
            checked={selected.has(item.id)}
            onCheckedChange={() => onToggle(item.id)}
            className="mt-0.5 shrink-0"
          />
          <div className="min-w-0">
            <p className="text-xs font-medium leading-tight">{item.name}</p>
            {item.description && (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {item.description}
              </p>
            )}
          </div>
        </label>
      ))}
    </div>
  );
}

// Main component

interface BuiltinAgentEditorProps {
  /** Existing agent id to edit, or null to create a new agent. */
  agentId: string | null;
  onBack: () => void;
  onSaved: (updated: BuiltinAgentRow) => void;
  /** Called after a successful POST (new agent). If omitted, onSaved is called. */
  onCreated?: (created: BuiltinAgentRow) => void;
  /**
   * Called after a successful DELETE. If omitted, `onBack` is invoked
   * so the user lands back on the agent list either way.
   */
  onDeleted?: (deletedId: string) => void;
}

export function BuiltinAgentEditor({ agentId, onBack, onSaved, onCreated, onDeleted }: BuiltinAgentEditorProps) {
  const isNew = agentId === null;
  // Remote data
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [mcpServers, setMcpServers] = useState<MpcServer[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [builtinToolCatalog, setBuiltinToolCatalog] = useState<BuiltinToolDescriptor[]>([]);
  /** Data sources visible to this user (own + public). The check
   *  list below maps these to the toolType="datasource" junction
   *  rows. Disabled rows are filtered out — agents shouldn't be
   *  able to bind something the runtime will reject. */
  const [dataSources, setDataSources] = useState<
    Array<{ id: string; name: string; description: string | null; provider: string; enabled: boolean }>
  >([]);
  /** SSH servers visible to this user (own + public). The check
   *  list below maps these to the toolType="ssh_server" junction
   *  rows. Disabled rows are filtered out. */
  const [sshServers, setSshServers] = useState<
    Array<{ id: string; name: string; description: string | null; host: string; username: string; enabled: boolean }>
  >([]);
  /** LLM credentials available to pick from */
  const [llmCredentials, setLlmCredentials] = useState<LlmCredential[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /** One-line persona surfaced to the supervisor's `list_agents`. */
  const [role, setRole] = useState("");
  /** Optional emoji glyph; null = "use the default". */
  const [icon, setIcon] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [toolChoice, setToolChoice] = useState("auto");
  const [maxSteps, setMaxSteps] = useState(5);
  const [temperature, setTemperature] = useState<number>(0.3);
  /** Whether this agent is the user's Nango (supervisor). */
  const [isSupervisor, setIsSupervisor] = useState(false);
  /**
   * id of another agent that is already the user's Nango. When set
   * (and != this agent), the "Set as Nango" checkbox is disabled —
   * the user must demote that one first.
   */
  const [otherSupervisorId, setOtherSupervisorId] = useState<string | null>(null);
  const [selectedMcp, setSelectedMcp] = useState<Set<string>>(new Set());
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedBuiltinTools, setSelectedBuiltinTools] = useState<Set<string>>(new Set());
  const [selectedDataSources, setSelectedDataSources] = useState<Set<string>>(new Set());
  const [selectedSshServers, setSelectedSshServers] = useState<Set<string>>(new Set());
  // KB placeholder — no table exists yet
  const [kbEnabled, setKbEnabled] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Delete state — destructive action, gated by a confirm dialog.
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Load
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [
        agentRes,
        toolsRes,
        skillsRes,
        allAgentsRes,
        builtinToolsRes,
        dataSourcesRes,
        sshServersRes,
      ] = await Promise.all([
        isNew ? Promise.resolve(null) : fetch(`/api/builtin-agents/${agentId}`),
        fetch("/api/tools"),
        fetch("/api/skills"),
        fetch("/api/builtin-agents"),
        fetch("/api/builtin-tools"),
        fetch("/api/data-sources"),
        fetch("/api/ssh-servers"),
      ]);
      if (!isNew && agentRes && agentRes.ok) {
        const data = await agentRes.json() as AgentDetail;
        setAgent(data);
        setName(data.name);
        setDescription(data.description ?? "");
        setRole(data.role ?? "");
        setIcon(data.icon ?? null);
        setModel(data.model);
        setModelProvider(data.modelProvider);
        setCredentialId(data.credentialId ?? null);
        setPrompt(data.prompt ?? "");
        setToolChoice(data.toolChoice ?? "auto");
        setMaxSteps(data.maxSteps ?? 5);
        setTemperature(data.temperature != null ? parseFloat(data.temperature) : 0.3);
        setIsSupervisor(data.isSupervisor === true);
        // Initialise selections from bound tools
        const mcp = new Set<string>();
        const sk = new Set<string>();
        const bt = new Set<string>();
        const ds = new Set<string>();
        const ssh = new Set<string>();
        for (const t of data.tools ?? []) {
          if ((t.toolType === "mcp_server" || t.toolType === "mcp_tool") && t.mcpServerId) mcp.add(t.mcpServerId);
          if (t.toolType === "skill" && t.skillId) sk.add(t.skillId);
          if (t.toolType === "builtin_tool" && t.builtinTool) bt.add(t.builtinTool);
          if (t.toolType === "datasource" && t.dataSourceId) ds.add(t.dataSourceId);
          if (t.toolType === "ssh_server" && t.sshServerId) ssh.add(t.sshServerId);
        }
        setSelectedMcp(mcp);
        setSelectedSkills(sk);
        setSelectedBuiltinTools(bt);
        setSelectedDataSources(ds);
        setSelectedSshServers(ssh);
      }
      if (toolsRes.ok) {
        const { mcpServers: m, llmCredentials: lc } = await toolsRes.json() as { mcpServers: MpcServer[]; llmCredentials: LlmCredential[] };
        setMcpServers(m);
        setLlmCredentials(lc ?? []);
      }
      if (skillsRes.ok) {
        setSkills(await skillsRes.json() as Skill[]);
      }
      if (builtinToolsRes.ok) {
        setBuiltinToolCatalog(await builtinToolsRes.json() as BuiltinToolDescriptor[]);
      }
      if (dataSourcesRes.ok) {
        const all = (await dataSourcesRes.json()) as Array<{
          id: string;
          name: string;
          description: string | null;
          provider: string;
          enabled: boolean;
        }>;
        // Filter out disabled rows — they are rejected by the runtime.
        setDataSources(all.filter((d) => d.enabled));
      }
      if (sshServersRes.ok) {
        const all = (await sshServersRes.json()) as Array<{
          id: string;
          name: string;
          description: string | null;
          host: string;
          username: string;
          enabled: boolean;
        }>;
        setSshServers(all.filter((s) => s.enabled));
      }
      if (allAgentsRes.ok) {
        // Find an existing supervisor that is not the current agent to flag the slot as occupied.
        const all = (await allAgentsRes.json()) as Array<{ id: string; isSupervisor?: boolean; createdBy?: string }>;
        const other = all.find(
          (a) => a.isSupervisor === true && a.id !== (agentId ?? ""),
        );
        setOtherSupervisorId(other?.id ?? null);
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [agentId, isNew]);

  useEffect(() => { startTransition(() => { void load(); }); }, [load]);

  // Model select handler
  // (provider and model id are now edited independently — no combined handler)

  // Toggle helpers
  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }

  // Save
  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    // Build flat tool list: one row per selected tool/skill/mcp.
    const tools = [
      ...[...selectedMcp].map((id) => ({ toolType: "mcp_server", mcpServerId: id })),
      ...[...selectedSkills].map((id) => ({ toolType: "skill", skillId: id })),
      ...[...selectedBuiltinTools].map((name) => ({ toolType: "builtin_tool", builtinTool: name })),
      ...[...selectedDataSources].map((id) => ({ toolType: "datasource", dataSourceId: id })),
      ...[...selectedSshServers].map((id) => ({ toolType: "ssh_server", sshServerId: id })),
    ];

    try {
      const body = {
        name: name.trim() || "New Agent",
        description: description.trim() || null,
        role: role.trim() || null,
        icon: icon,
        model,
        modelProvider,
        credentialId,
        prompt: prompt.trim() || null,
        toolChoice,
        maxSteps,
        temperature,
        isSupervisor,
        tools,
      };

      const res = isNew
        ? await fetch("/api/builtin-agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/builtin-agents/${agentId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

      if (!res.ok) {
        // Standard error envelope from API HOFs is
        // `{ ok:false, code, message, requestId }`; `error` is kept
        // as a fallback for any un-migrated path.
        const err = (await res.json()) as { message?: string; error?: string };
        setSaveError(err.message ?? err.error ?? "Save failed");
      } else {
        const result = await res.json() as BuiltinAgentRow;
        if (isNew) {
          (onCreated ?? onSaved)(result);
        } else {
          onSaved(result);
        }
      }
    } catch {
      setSaveError("Network error");
    }
    setSaving(false);
  }

  /**
   * Delete the current agent. Confirmation already happened (dialog),
   * so this just fires the DELETE and routes the user back to the list
   * via `onDeleted` (or `onBack` as a fallback).
   *
   * Errors surface through `saveError` — the row stays on screen so
   * the user can retry or back out.
   */
  async function handleDeleteConfirm(): Promise<void> {
    if (isNew || agentId === null) return;
    setDeleting(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/builtin-agents/${agentId}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        setDeleteOpen(false);
        if (onDeleted) onDeleted(agentId);
        else onBack();
        return;
      }
      const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setSaveError(err.message ?? err.error ?? "Delete failed");
    } catch {
      setSaveError("Network error during delete");
    } finally {
      setDeleting(false);
    }
  }

  // Render
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isNew && !agent) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">Agent not found</span>
        </div>
      </div>
    );
  }

  const headerTitle = isNew ? "Create Agent" : (agent?.name ?? "");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      {(() => {
        // Same disabled rule as the previous inline block — slot is
        // "taken" only when another agent already holds the flag.
        const supervisorSlotTaken =
          !isSupervisor && otherSupervisorId !== null && otherSupervisorId !== agentId;
        return (
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onBack} aria-label="Back to agent list">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{headerTitle}</span>
            {/*
             * Promotion toggle — semantically special (one Nango per
             * user), so it sits next to Save instead of mixed into the
             * Basic params. First-time promotion seeds the default
             * prompt only if the user hasn't authored one; demotion
             * leaves any edits intact.
             */}
            <label
              className={cn(
                // mr-4 widens the gap before Save so the toggle reads
                // as a distinct, semantically-different control rather
                // than another button-row item.
                "mr-4 flex shrink-0 items-center gap-1.5",
                supervisorSlotTaken ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              )}
              title={
                supervisorSlotTaken
                  ? "You already have a Nango. Demote it first to designate a new one."
                  : "Your personal supervisor that can delegate tasks to other agents. Only one Nango per user."
              }
            >
              <span className="text-xs font-medium">Set as Nango</span>
              <Switch
                checked={isSupervisor}
                disabled={supervisorSlotTaken}
                onCheckedChange={(v) => {
                  setIsSupervisor(v);
                  if (v && prompt.trim().length === 0) {
                    setPrompt(SUPERVISOR_PERSONA_SEED);
                  }
                }}
              />
            </label>
            <Button
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-3 text-xs"
              onClick={handleSave}
              disabled={saving || deleting}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
            {/*
             * Delete — destructive, low-frequency action moved here
             * from the agent list (where a hover-revealed trash icon
             * invited accidental clicks). Only rendered when editing
             * an existing agent; the confirm dialog gates the actual
             * DELETE call.
             */}
            {!isNew && (
              <Button
                size="sm"
                // Same background as Save (default variant uses
                // `bg-primary`), only the text colour switches to
                // destructive red. In dark mode that maps to
                // "white bg + red text", parallel to Save's
                // "white bg + black text" — so both buttons look like
                // siblings, distinguished purely by text hue.
                className="h-7 shrink-0 gap-1.5 px-3 text-xs bg-primary text-destructive hover:bg-primary/80 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={saving || deleting}
                title="Delete this agent (cannot be undone)"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete
              </Button>
            )}
          </div>
        );
      })()}

      {/* ── Delete confirmation dialog ──────────────────────────── */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <strong>{agent?.name ?? "this agent"}</strong>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // The dialog auto-closes on action; we want to await
                // the DELETE first so the dialog stays up while the
                // request is in flight, then close on success.
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {saveError && (
        <p className="px-4 py-1.5 text-xs text-destructive">{saveError}</p>
      )}

      {/*
       * Two-column layout (lg+):
       *   - LEFT  column: Basic (single-line fields, stacked) + the six
       *                   tool selection sections in order.
       *   - RIGHT column: System Prompt only. The textarea is the most
       *                   space-hungry control in the editor; giving it
       *                   its own column means users can author long
       *                   prompts without scrolling past 8 unrelated
       *                   tool sections to see what they're typing.
       *
       * The right column uses `lg:sticky lg:top-0 lg:h-[…]` so the
       * prompt stays anchored at the top of the visible area while the
       * left column scrolls. The whole composition lives inside a
       * single ScrollArea — the outer scroll container — so we get one
       * scrollbar instead of two competing ones.
       *
       * Below `lg` (< 1024px) the grid collapses to one column:
       * Basic → System Prompt → Tools in linear order, which is the
       * old behaviour and reads fine on narrow viewports.
       */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          {/* ── LEFT COLUMN ─────────────────────────────────────── */}
          {/* `lg:pr-3` (12 px) keeps the left column's right edge a
              short distance from the centre divider. The right column
              mirrors it with `lg:pl-3` so both columns sit
              symmetrically around the divider; the page-edge gutters
              are owned by Section's own `px-4`. */}
          <div className="lg:pr-3">
            {/* ── Basic info — single-line per field ── */}
            <Section title="Basic">
              <div className="flex items-center gap-2">
                <Label className="w-24 shrink-0 text-xs">Name</Label>
                <Input
                  value={name}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                  className="h-8 flex-1 text-xs"
                />
                {/* Emoji picker trails the input — see "icon picker
                    placement" note: it's a secondary affordance, not
                    the primary identity control. */}
                <EmojiPicker
                  value={icon}
                  onChange={setIcon}
                  onClear={() => setIcon(null)}
                  size={32}
                  ariaLabel="Pick agent icon"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label
                  className="w-24 shrink-0 text-xs"
                  title="Persona shown to the supervisor when it picks an agent for delegation."
                >
                  Role
                </Label>
                <Input
                  value={role}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setRole(e.target.value)}
                  className="h-8 flex-1 text-xs"
                  placeholder="e.g. Senior Python developer"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-24 shrink-0 text-xs">Description</Label>
                <Input
                  value={description}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
                  className="h-8 flex-1 text-xs"
                  placeholder="What this agent does (one-sentence summary surfaced to the supervisor)"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-24 shrink-0 text-xs">Provider</Label>
                <Select
                  value={credentialId ?? ""}
                  items={llmCredentials.map((c) => ({
                    value: c.id,
                    label: c.name + (c.provider ? ` (${getProviderLabel(c.provider)})` : ""),
                  }))}
                  onValueChange={(v: string | null) => {
                    if (!v) { setCredentialId(null); return; }
                    const cred = llmCredentials.find((c) => c.id === v);
                    setCredentialId(v);
                    if (cred?.provider) setModelProvider(cred.provider);
                  }}
                >
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue placeholder="Select credential" />
                  </SelectTrigger>
                  <SelectContent>
                    {llmCredentials.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No API keys configured. Add credentials first.
                      </div>
                    ) : (
                      llmCredentials.map((c) => (
                        <SelectItem key={c.id} value={c.id} className="text-xs">
                          {c.name}{c.provider ? ` (${getProviderLabel(c.provider)})` : ""}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-24 shrink-0 text-xs">Model ID</Label>
                <Input
                  value={model}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setModel(e.target.value)}
                  className="h-8 flex-1 font-mono text-xs"
                  placeholder="e.g. gpt-4o, claude-3-5-sonnet-20241022"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-24 shrink-0 text-xs">Temperature</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={temperature}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const v = parseFloat(e.target.value);
                    setTemperature(Number.isNaN(v) ? 0.3 : Math.min(1, Math.max(0, v)));
                  }}
                  className="h-8 flex-1 text-xs"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-24 shrink-0 text-xs">Tool Choice</Label>
                <Select
                  value={toolChoice}
                  onValueChange={(v: string | null) => setToolChoice(v ?? "auto")}
                >
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-xs">Auto</SelectItem>
                    <SelectItem value="required" className="text-xs">Required</SelectItem>
                    <SelectItem value="none" className="text-xs">None</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-24 shrink-0 text-xs">Max Steps</Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={maxSteps}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setMaxSteps(Math.max(1, parseInt(e.target.value) || 1))}
                  className="h-8 flex-1 text-xs"
                />
              </div>
            </Section>

            {/* ── Tools — all six sections, full-width inside left col ── */}
            <Section
              title="Skills"
              defaultOpen={false}
              count={{ selected: selectedSkills.size, total: skills.length }}
            >
              <CheckList
                items={skills}
                selected={selectedSkills}
                onToggle={(id) => setSelectedSkills(toggle(selectedSkills, id))}
                emptyText="No skills available."
              />
            </Section>

            <Section
              title="MCP Servers"
              defaultOpen={false}
              count={{ selected: selectedMcp.size, total: mcpServers.length }}
            >
              <CheckList
                items={mcpServers}
                selected={selectedMcp}
                onToggle={(id) => setSelectedMcp(toggle(selectedMcp, id))}
                emptyText="No MCP servers configured."
              />
            </Section>

            <Section
              title="Built-in Tools"
              defaultOpen={false}
              count={{
                selected: selectedBuiltinTools.size,
                total: builtinToolCatalog.length,
              }}
            >
              <CheckList
                items={builtinToolCatalog.map((t) => ({
                  id: t.name,
                  name: t.displayName,
                  description: t.description,
                }))}
                selected={selectedBuiltinTools}
                onToggle={(id) => setSelectedBuiltinTools(toggle(selectedBuiltinTools, id))}
                emptyText="No built-in tools available."
              />
            </Section>

            <Section
              title="SSH Hosts"
              defaultOpen={false}
              count={{ selected: selectedSshServers.size, total: sshServers.length }}
            >
              <CheckList
                items={sshServers.map((s) => ({
                  id: s.id,
                  name: s.name,
                  description:
                    s.description ?? `${s.username}@${s.host}`,
                }))}
                selected={selectedSshServers}
                onToggle={(id) => setSelectedSshServers(toggle(selectedSshServers, id))}
                emptyText="No enabled SSH servers. Create one from the SSH Hosts panel."
              />
            </Section>

            <Section
              title="Data Sources"
              defaultOpen={false}
              count={{ selected: selectedDataSources.size, total: dataSources.length }}
            >
              <CheckList
                items={dataSources.map((d) => ({
                  id: d.id,
                  name: d.name,
                  description: d.description ?? d.provider,
                }))}
                selected={selectedDataSources}
                onToggle={(id) => setSelectedDataSources(toggle(selectedDataSources, id))}
                emptyText="No enabled data sources. Create one from the Data Sources panel."
              />
            </Section>

            {/* Knowledge Base (placeholder) */}
            <Section title="Knowledge Base" defaultOpen={false}>
              <label className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 hover:bg-muted/40")}>
                <Checkbox
                  checked={kbEnabled}
                  onCheckedChange={(v: boolean | "indeterminate") => setKbEnabled(v === true)}
                />
                <div>
                  <p className="text-xs font-medium">Enable knowledge base</p>
                  <p className="text-[11px] text-muted-foreground">
                    Knowledge base support is coming soon.
                  </p>
                </div>
              </label>
            </Section>
          </div>

          {/* RIGHT COLUMN: System Prompt. `lg:sticky` so it stays
              visible while the left column scrolls. */}
          <div className="lg:sticky lg:top-0 lg:self-start lg:border-l lg:border-border/40 lg:pl-3">
            <Section
              title="System Prompt"
              actions={
                isSupervisor ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px]"
                    onClick={() => setPrompt(SUPERVISOR_PERSONA_SEED)}
                    title="Replace the prompt with the Nango default."
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restore default
                  </Button>
                ) : undefined
              }
            >
              <Textarea
                value={prompt}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value)}
                placeholder="You are a helpful assistant…"
                // Override `field-sizing-content` (default in the
                // shadcn Textarea base) so the box keeps a fixed
                // viewport-relative height with internal scroll. The
                // sticky right column already gives the prompt the
                // whole right pane — resize is removed (`resize-none`)
                // since dragging the handle would only push the box
                // beyond the column and trigger a page-level scroll.
                // `h-[calc(100vh-12rem)]` reserves room for the page
                // header + Section title strip on typical viewports.
                className="!field-sizing-fixed h-[calc(100vh-12rem)] min-h-64 resize-none overflow-y-auto font-mono text-xs leading-relaxed"
              />
            </Section>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
