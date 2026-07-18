"use client";

/**
 * BuiltinAgentEditor — inline right-panel editor for a single BuiltIn agent.
 */

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  startTransition,
  type ReactNode,
  type ChangeEvent,
} from "react";
import { ArrowLeft, Save, Loader2, ChevronDown, ChevronRight, Trash2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import { getProviderLabel } from "@/lib/constants/providers";
import {
  SUPERVISOR_DESCRIPTION,
  SUPERVISOR_NAME,
  SUPERVISOR_PROMPT,
} from "@/lib/constants/supervisor";
import type { AgentRole } from "@/lib/db/schema";
import { DEFAULT_EVALUATOR_SYSTEM_PROMPT } from "@/lib/evaluation/types";
export type { BuiltinAgentRow, BoundToolRow } from "@/lib/types/builtin-agent";
import type { BuiltinAgentRow, BoundToolRow } from "@/lib/types/builtin-agent";

// Types

interface MpcServer { id: string; name: string; description: string | null; serverDescription?: string | null; serverInstructions?: string | null; url: string; enabled: boolean }
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
  headerClassName,
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
  headerClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/40">
      <div className={cn("flex items-center gap-1.5 px-4 py-2.5", headerClassName)}>
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
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
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

// Form state

interface FormState {
  name: string;
  description: string;
  icon: string | null;
  model: string;
  modelProvider: string;
  credentialId: string | null;
  prompt: string;
  toolChoice: string;
  toolApprovalMode: string;
  maxSteps: number;
  temperature: number;
  role: AgentRole | null;
  kbEnabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  icon: null,
  model: "",
  modelProvider: "",
  credentialId: null,
  prompt: "",
  toolChoice: "auto",
  toolApprovalMode: "never",
  maxSteps: 5,
  temperature: 0.3,
  role: null,
  kbEnabled: false,
};

function formFromDetail(data: AgentDetail): FormState {
  return {
    name: data.name,
    description: data.description ?? "",
    icon: data.icon ?? null,
    model: data.model,
    modelProvider: data.modelProvider,
    credentialId: data.credentialId ?? null,
    prompt: data.prompt ?? "",
    toolChoice: data.toolChoice ?? "auto",
    toolApprovalMode: data.toolApprovalMode ?? "never",
    maxSteps: data.maxSteps ?? 5,
    temperature: data.temperature != null ? parseFloat(data.temperature) : 0.3,
    role: data.role ?? null,
    kbEnabled: false,
  };
}

interface ToolSelections {
  mcp: Set<string>;
  skills: Set<string>;
  builtinTools: Set<string>;
  dataSources: Set<string>;
  sshServers: Set<string>;
  calendars: Set<string>;
}

const EMPTY_TOOLS: ToolSelections = {
  mcp: new Set(),
  skills: new Set(),
  builtinTools: new Set(),
  dataSources: new Set(),
  sshServers: new Set(),
  calendars: new Set(),
};

function toolsFromBoundRows(rows: BoundToolRow[]): ToolSelections {
  const mcp = new Set<string>();
  const skills = new Set<string>();
  const builtinTools = new Set<string>();
  const dataSources = new Set<string>();
  const sshServers = new Set<string>();
  const calendars = new Set<string>();
  for (const t of rows) {
    if ((t.toolType === "mcp_server" || t.toolType === "mcp_tool") && t.mcpServerId) mcp.add(t.mcpServerId);
    if (t.toolType === "skill" && t.skillId) skills.add(t.skillId);
    if (t.toolType === "builtin_tool" && t.builtinTool) builtinTools.add(t.builtinTool);
    if (t.toolType === "datasource" && t.dataSourceId) dataSources.add(t.dataSourceId);
    if (t.toolType === "ssh_server" && t.sshServerId) sshServers.add(t.sshServerId);
    if (t.toolType === "calendar" && t.calendarCredentialId) calendars.add(t.calendarCredentialId);
  }
  return { mcp, skills, builtinTools, dataSources, sshServers, calendars };
}

/** Serialize tool selections for dirty comparison (Sets are not JSON-comparable). */
function serializeTools(t: ToolSelections): string {
  return JSON.stringify({
    mcp: [...t.mcp].sort(),
    skills: [...t.skills].sort(),
    builtinTools: [...t.builtinTools].sort(),
    dataSources: [...t.dataSources].sort(),
    sshServers: [...t.sshServers].sort(),
    calendars: [...t.calendars].sort(),
  });
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
  /** Calendar credentials (serviceType="calendar") available for binding. */
  const [calendars, setCalendars] = useState<
    Array<{ id: string; name: string; description: string | null; provider: string | null }>
  >([]);
  /** LLM credentials available to pick from */
  const [llmCredentials, setLlmCredentials] = useState<LlmCredential[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state — single object for all editable scalar fields.
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [savedForm, setSavedForm] = useState<FormState>(EMPTY_FORM);
  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  // Tool selections — grouped into one object (5 Sets).
  const [tools, setTools] = useState<ToolSelections>(EMPTY_TOOLS);
  const [savedTools, setSavedTools] = useState<ToolSelections>(EMPTY_TOOLS);
  function toggleTool(category: keyof ToolSelections, id: string): void {
    setTools((prev) => {
      const next = new Set(prev[category]);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...prev, [category]: next };
    });
  }

  // Dirty tracking — drives the Save button's disabled state.
  const isDirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(savedForm) ||
      serializeTools(tools) !== serializeTools(savedTools),
    [form, savedForm, tools, savedTools],
  );

  // Copilot draft integration — merge form + tools into a single
  // serializable object for the agent, split back on apply.
  const getCurrentData = useCallback(
    () => ({
      ...form,
      tools: {
        mcp: [...tools.mcp].sort(),
        skills: [...tools.skills].sort(),
        builtinTools: [...tools.builtinTools].sort(),
        dataSources: [...tools.dataSources].sort(),
        sshServers: [...tools.sshServers].sort(),
      },
    }) as Record<string, unknown>,
    [form, tools],
  );
  const applyDraft = useCallback((draft: Record<string, unknown>) => {
    const { tools: draftTools, ...formFields } = draft;
    if (Object.keys(formFields).length > 0) {
      setForm((prev) => ({ ...prev, ...formFields as Partial<FormState> }));
    }
    if (draftTools && typeof draftTools === "object" && !Array.isArray(draftTools)) {
      const t = draftTools as Record<string, string[]>;
      setTools((prev) => ({
        mcp:          Array.isArray(t.mcp)          ? new Set(t.mcp)          : prev.mcp,
        skills:       Array.isArray(t.skills)       ? new Set(t.skills)       : prev.skills,
        builtinTools: Array.isArray(t.builtinTools) ? new Set(t.builtinTools) : prev.builtinTools,
        dataSources:  Array.isArray(t.dataSources)  ? new Set(t.dataSources)  : prev.dataSources,
        sshServers:   Array.isArray(t.sshServers)   ? new Set(t.sshServers)   : prev.sshServers,
        calendars:    Array.isArray(t.calendars)    ? new Set(t.calendars)    : prev.calendars,
      }));
    }
  }, []);
  const { draftApplied, clearDraftState } = useCopilotDraft({
    resourceType: "agent",
    getCurrentData,
    applyDraft,
  });

  /** Server-side role at load time. Non-null = role frozen by the
   *  monotonic rule; the toggle goes readonly. */
  const [loadedRole, setLoadedRole] = useState<AgentRole | null>(null);
  /** Snapshot of name/description/prompt taken on "Set as Nango" ON
   *  so cancelling restores the user's prior input.
   *  QUIRK: useRef, not useState — pure side-channel, no re-render. */
  const preSupervisorSnapshot = useRef<
    Pick<FormState, "name" | "description" | "prompt"> | null
  >(null);
  /** id of another agent already holding the supervisor slot for this
   *  user; disables the option until that one is deleted. */
  const [otherSupervisorId, setOtherSupervisorId] = useState<string | null>(null);
  const [otherSecretaryId, setOtherSecretaryId] = useState<string | null>(null);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Delete state — destructive action, gated by a confirm dialog.
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Tab states for tool grouping
  type TabId = "skills" | "mcp" | "builtin" | "ssh" | "datasource" | "calendar" | "knowledge";
  const [activeTab, setActiveTab] = useState<TabId>("mcp");
  const tabListRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = tabListRef.current;
    if (el) {
      setCanScrollLeft(el.scrollLeft > 1);
      setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
    }
  }, []);

  const handleTabScroll = useCallback((direction: "left" | "right") => {
    const el = tabListRef.current;
    if (el) {
      const scrollAmount = 120;
      el.scrollBy({
        left: direction === "left" ? -scrollAmount : scrollAmount,
        behavior: "smooth",
      });
    }
  }, []);

  useEffect(() => {
    const el = tabListRef.current;
    if (el) {
      el.addEventListener("scroll", checkScroll);
      window.addEventListener("resize", checkScroll);
      checkScroll();
    }
    return () => {
      if (el) {
        el.removeEventListener("scroll", checkScroll);
      }
      window.removeEventListener("resize", checkScroll);
    };
  }, [checkScroll]);

  useEffect(() => {
    const timer = setTimeout(checkScroll, 100);
    return () => clearTimeout(timer);
  }, [activeTab, skills, mcpServers, builtinToolCatalog, sshServers, dataSources, calendars, checkScroll]);

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
        calendarsRes,
      ] = await Promise.all([
        isNew ? Promise.resolve(null) : fetch(`/api/builtin-agents/${agentId}`),
        fetch("/api/tools"),
        fetch("/api/skills"),
        fetch("/api/builtin-agents"),
        fetch("/api/builtin-tools"),
        fetch("/api/data-sources"),
        fetch("/api/ssh-servers"),
        fetch("/api/calendar-credentials"),
      ]);
      if (!isNew && agentRes && agentRes.ok) {
        const data = await agentRes.json() as AgentDetail;
        setAgent(data);
        const loadedForm = formFromDetail(data);
        setForm(loadedForm);
        setSavedForm(loadedForm);
        setLoadedRole(data.role ?? null);
        const loadedTools = toolsFromBoundRows(data.tools ?? []);
        setTools(loadedTools);
        setSavedTools(loadedTools);
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
      if (calendarsRes.ok) {
        const all = (await calendarsRes.json()) as Array<{
          id: string;
          name: string;
          description: string | null;
          provider: string | null;
        }>;
        setCalendars(all);
      }
      if (allAgentsRes.ok) {
        // Find existing system agents to flag their slots as occupied.
        const all = (await allAgentsRes.json()) as Array<{ id: string; role?: AgentRole | null; createdBy?: string }>;
        const otherSup = all.find(
          (a) => a.role === "supervisor" && a.id !== (agentId ?? ""),
        );
        setOtherSupervisorId(otherSup?.id ?? null);
        const otherSec = all.find(
          (a) => a.role === "secretary" && a.id !== (agentId ?? ""),
        );
        setOtherSecretaryId(otherSec?.id ?? null);
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [agentId, isNew]);

  useEffect(() => { startTransition(() => { void load(); }); }, [load]);

  // Save
  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    // Build flat tool list from consolidated ToolSelections.
    const toolList = [
      ...[...tools.mcp].map((id) => ({ toolType: "mcp_server", mcpServerId: id })),
      ...[...tools.skills].map((id) => ({ toolType: "skill", skillId: id })),
      ...[...tools.builtinTools].map((n) => ({ toolType: "builtin_tool", builtinTool: n })),
      ...[...tools.dataSources].map((id) => ({ toolType: "datasource", dataSourceId: id })),
      ...[...tools.sshServers].map((id) => ({ toolType: "ssh_server", sshServerId: id })),
      ...[...tools.calendars].map((id) => ({ toolType: "calendar", calendarCredentialId: id })),
    ];

    try {
      const targetRole: AgentRole | null = form.role;
      const body = {
        name: form.name.trim() || "New Agent",
        description: form.description.trim() || null,
        role: targetRole,
        icon: form.icon,
        model: form.model,
        modelProvider: form.modelProvider,
        credentialId: form.credentialId,
        prompt: form.prompt.trim() || null,
        toolChoice: form.toolChoice,
        toolApprovalMode: form.toolApprovalMode,
        maxSteps: form.maxSteps,
        temperature: form.temperature,
        tools: toolList,
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
        clearDraftState();
        if (isNew) {
          (onCreated ?? onSaved)(result);
        } else {
          onSaved(result);
        }
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
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
  const roleIsFrozen = loadedRole !== null;
  const supervisorSlotTaken = !roleIsFrozen && form.role !== "supervisor" && otherSupervisorId !== null && otherSupervisorId !== agentId;
  const secretarySlotTaken = !roleIsFrozen && form.role !== "secretary" && otherSecretaryId !== null && otherSecretaryId !== agentId;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onBack} aria-label="Back to agent list">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{headerTitle}</span>
        <Button
          size="sm"
          className={cn("h-7 shrink-0 gap-1.5 px-3 text-xs", draftApplied && "bg-amber-600 hover:bg-amber-700 text-white")}
          onClick={handleSave}
              disabled={saving || deleting || (!isNew && !isDirty && !draftApplied)}
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
      <DeleteConfirmDialog
        title="Delete agent"
        description={<>Permanently delete <strong>{agent?.name ?? "this agent"}</strong>? This cannot be undone.</>}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void handleDeleteConfirm()}
        deleting={deleting}
      />

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
            <Section title="Basic" headerClassName="bg-muted/30">
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Name</Label>
                <Input
                  value={form.name}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => update("name", e.target.value)}
                  readOnly={form.role === "supervisor"}
                  className={cn("h-8 flex-1 text-xs", form.role === "supervisor" && "bg-muted text-muted-foreground")}
                  title={form.role === "supervisor" ? "Supervisor name is locked." : undefined}
                />
                <EmojiPicker
                  value={form.icon}
                  onChange={(v) => update("icon", v)}
                  onClear={() => update("icon", null)}
                  size={32}
                  ariaLabel="Pick agent icon"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Description</Label>
                <Input
                  value={form.description}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => update("description", e.target.value)}
                  readOnly={form.role === "supervisor"}
                  className={cn(
                    "h-8 flex-1 text-xs",
                    form.role === "supervisor" && "bg-muted text-muted-foreground",
                  )}
                  placeholder="One-sentence summary of the agent's responsibility"
                  title={form.role === "supervisor" ? "Supervisor description is locked." : undefined}
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Role</Label>
                <Select
                  value={form.role ?? "specialist"}
                  disabled={roleIsFrozen}
                  onValueChange={(v: string | null) => {
                    if (roleIsFrozen || !v) return;
                    const newRole = v === "specialist" ? null : (v as AgentRole);
                    
                    if (newRole === "supervisor") {
                      preSupervisorSnapshot.current = {
                        name: form.name,
                        description: form.description,
                        prompt: form.prompt,
                      };
                      setForm((prev) => ({
                        ...prev,
                        role: newRole,
                        name: SUPERVISOR_NAME,
                        description: SUPERVISOR_DESCRIPTION,
                        prompt: SUPERVISOR_PROMPT,
                      }));
                    } else {
                      const snap = preSupervisorSnapshot.current;
                      setForm((prev) => {
                        const restored = prev.role === "supervisor" && snap ? snap : {};
                        const nextName = (prev.role === "supervisor" ? snap?.name : undefined) ?? prev.name;
                        const nextPrompt = (prev.role === "supervisor" ? snap?.prompt : undefined) ?? prev.prompt;
                        
                        return {
                          ...prev,
                          role: newRole,
                          ...restored,
                          ...(newRole === "evaluator" && nextPrompt.trim() === "" ? { prompt: DEFAULT_EVALUATOR_SYSTEM_PROMPT } : {}),
                          ...(newRole === "evaluator" && nextName.trim() === "" ? { name: "Evaluator" } : {}),
                        };
                      });
                      if (form.role === "supervisor") {
                         preSupervisorSnapshot.current = null;
                      }
                    }
                  }}
                >
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="specialist" className="text-xs">Specialist</SelectItem>
                    <SelectItem value="supervisor" disabled={supervisorSlotTaken} className="text-xs">
                      Supervisor
                    </SelectItem>
                    <SelectItem value="secretary" disabled={secretarySlotTaken} className="text-xs">
                      Secretary
                    </SelectItem>
                    <SelectItem value="evaluator" className="text-xs">Evaluator</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Provider</Label>
                <Select
                  value={form.credentialId ?? ""}
                  items={llmCredentials.map((c) => ({
                    value: c.id,
                    label: c.name + (c.provider ? ` (${getProviderLabel(c.provider)})` : ""),
                  }))}
                  onValueChange={(v: string | null) => {
                    if (!v) { update("credentialId", null); return; }
                    const cred = llmCredentials.find((c) => c.id === v);
                    update("credentialId", v);
                    if (cred?.provider) update("modelProvider", cred.provider);
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
                <Label className="w-20 shrink-0 text-xs">Model ID</Label>
                <Input
                  value={form.model}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => update("model", e.target.value)}
                  className="h-8 flex-1 font-mono text-xs"
                  placeholder="e.g. gpt-4o, claude-3-5-sonnet-20241022"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Temperature</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={form.temperature}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const v = parseFloat(e.target.value);
                    update("temperature", Number.isNaN(v) ? 0.3 : Math.min(1, Math.max(0, v)));
                  }}
                  className="h-8 flex-1 text-xs"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Tool Approval</Label>
                <Select
                  value={form.toolApprovalMode}
                  onValueChange={(v: string | null) => update("toolApprovalMode", v ?? "never")}
                >
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always" className="text-xs">Always (ask for all)</SelectItem>
                    <SelectItem value="auto" className="text-xs">Auto (ask for sensitive)</SelectItem>
                    <SelectItem value="never" className="text-xs">Never (skip all)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Tool Choice</Label>
                <Select
                  value={form.toolChoice}
                  onValueChange={(v: string | null) => update("toolChoice", v ?? "auto")}
                >
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-xs">Auto (model decides)</SelectItem>
                    <SelectItem value="required" className="text-xs">Required (force tool call)</SelectItem>
                    <SelectItem value="none" className="text-xs">None (disable tools)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-20 shrink-0 text-xs">Max Steps</Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={form.maxSteps}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => update("maxSteps", Math.max(1, parseInt(e.target.value) || 1))}
                  className="h-8 flex-1 text-xs"
                />
              </div>
            </Section>

            {/* ── Tabs-based Tool Selection ── */}
            {(() => {
              const tabsConfig = [
                {
                  id: "mcp" as const,
                  label: "MCP",
                  count: { selected: tools.mcp.size, total: mcpServers.length },
                },
                {
                  id: "builtin" as const,
                  label: "Tool",
                  count: {
                    selected: [...tools.builtinTools].filter((n) =>
                      builtinToolCatalog.some((t) => t.name === n),
                    ).length,
                    total: builtinToolCatalog.length,
                  },
                },
                {
                  id: "skills" as const,
                  label: "Skill",
                  count: { selected: tools.skills.size, total: skills.length },
                },
                {
                  id: "ssh" as const,
                  label: "SSH",
                  count: { selected: tools.sshServers.size, total: sshServers.length },
                },
                {
                  id: "datasource" as const,
                  label: "Datasource",
                  count: { selected: tools.dataSources.size, total: dataSources.length },
                },
                {
                  id: "calendar" as const,
                  label: "Calendar",
                  count: { selected: tools.calendars.size, total: calendars.length },
                },
                {
                  id: "knowledge" as const,
                  label: "Knowledge",
                },
              ];
              
              return (
                <>
                  <div className="relative flex items-center mt-4 mx-4 p-1 rounded-lg bg-muted/40 border border-border/40">
                    {canScrollLeft && (
                      <div className="absolute left-1 z-10 flex items-center pr-2 bg-gradient-to-r from-muted/95 to-transparent">
                        <button
                          type="button"
                          onClick={() => handleTabScroll("left")}
                          className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-sm backdrop-blur-sm hover:bg-muted"
                          aria-label="Scroll tabs left"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    
                    <div
                      ref={tabListRef}
                      className="flex flex-1 gap-1 overflow-x-auto scrollbar-none scroll-smooth"
                    >
                      {tabsConfig.map((tab) => {
                        const active = activeTab === tab.id;
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                              "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                              active
                                ? "bg-background text-foreground shadow-xs"
                                : "text-muted-foreground hover:bg-background/40 hover:text-foreground"
                            )}
                          >
                            <span>{tab.label}</span>
                            {tab.count && (
                              <span
                                className={cn(
                                  "rounded px-1 text-[10px] tabular-nums font-semibold",
                                  active
                                    ? "bg-primary/10 text-primary"
                                    : "bg-muted-foreground/10 text-muted-foreground/70"
                                )}
                              >
                                {tab.count.selected}/{tab.count.total}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {canScrollRight && (
                      <div className="absolute right-1 z-10 flex items-center pl-2 bg-gradient-to-l from-muted/95 to-transparent">
                        <button
                          type="button"
                          onClick={() => handleTabScroll("right")}
                          className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-sm backdrop-blur-sm hover:bg-muted"
                          aria-label="Scroll tabs right"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="px-4 py-3 min-h-[220px]">
                    {activeTab === "skills" && (
                      <CheckList
                        items={skills}
                        selected={tools.skills}
                        onToggle={(id) => toggleTool("skills", id)}
                        emptyText="No skills available."
                      />
                    )}
                    {activeTab === "mcp" && (
                      <CheckList
                        items={mcpServers.map((s) => ({
                          ...s,
                          description: s.description || s.serverDescription || s.serverInstructions || s.url,
                        }))}
                        selected={tools.mcp}
                        onToggle={(id) => toggleTool("mcp", id)}
                        emptyText="No MCP servers configured."
                      />
                    )}
                    {activeTab === "builtin" && (
                      <CheckList
                        items={builtinToolCatalog.map((t) => ({
                          id: t.name,
                          name: t.displayName,
                          description: t.description,
                        }))}
                        selected={tools.builtinTools}
                        onToggle={(id) => toggleTool("builtinTools", id)}
                        emptyText="No built-in tools available."
                      />
                    )}
                    {activeTab === "ssh" && (
                      <CheckList
                        items={sshServers.map((s) => ({
                          id: s.id,
                          name: s.name,
                          description: s.description ?? `${s.username}@${s.host}`,
                        }))}
                        selected={tools.sshServers}
                        onToggle={(id) => toggleTool("sshServers", id)}
                        emptyText="No enabled SSH servers. Create one from the SSH Hosts panel."
                      />
                    )}
                    {activeTab === "datasource" && (
                      <CheckList
                        items={dataSources.map((d) => ({
                          id: d.id,
                          name: d.name,
                          description: d.description ?? d.provider,
                        }))}
                        selected={tools.dataSources}
                        onToggle={(id) => toggleTool("dataSources", id)}
                        emptyText="No enabled data sources. Create one from the Data Sources panel."
                      />
                    )}
                    {activeTab === "calendar" && (
                      <CheckList
                        items={calendars.map((c) => ({
                          id: c.id,
                          name: c.name,
                          description: c.description ?? c.provider ?? "ICS",
                        }))}
                        selected={tools.calendars}
                        onToggle={(id) => toggleTool("calendars", id)}
                        emptyText="No calendar credentials. Create one with service type 'Calendar' in Credentials."
                      />
                    )}
                    {activeTab === "knowledge" && (
                      <p className="text-xs text-muted-foreground py-2">
                        Knowledge base support is coming soon.
                      </p>
                    )}
                  </div>
                </>
              );
            })()}
          </div>

          {/* RIGHT COLUMN: System Prompt. `lg:sticky` so it stays
              visible while the left column scrolls. */}
          <div className="lg:sticky lg:top-0 lg:self-start lg:border-l lg:border-border/40 lg:pl-3">
            <Section title="System Prompt">
              <Textarea
                value={form.prompt}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => update("prompt", e.target.value)}
                readOnly={form.role === "supervisor"}
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
                className={cn(
                  "!field-sizing-fixed h-[calc(100vh-12rem)] min-h-64 resize-none overflow-y-auto font-mono text-xs leading-relaxed",
                  form.role === "supervisor" && "bg-muted text-muted-foreground",
                )}
                title={form.role === "supervisor" ? "Supervisor system prompt is locked." : undefined}
              />
            </Section>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
