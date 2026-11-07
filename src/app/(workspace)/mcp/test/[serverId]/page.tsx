"use client";

/**
 * MCP Tool Test Page
 */

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, Play, Loader2, Search, Save, ChevronDown, ChevronRight, Star, Copy, Check, Ban, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { JsonView } from "@/components/ui/json-view";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SaveAsCaseDialog } from "@/components/main-panels/verification/SaveAsCaseDialog";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/components/admin/format";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import {
  loadSnapshots,
  saveSnapshot,
  togglePin,
  type ToolExecutionSnapshot,
} from "@/lib/mcp/snapshots";

import { withTheme } from "@rjsf/core";
import { Theme as ShadcnTheme } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import type { FieldTemplateProps } from "@rjsf/utils";
import type { McpToolSnapshot, McpPromptSnapshot, McpResourceSnapshot } from "@/lib/db/schema";

const Form = withTheme(ShadcnTheme);

// Custom field template

function CustomFieldTemplate(props: FieldTemplateProps): ReactNode {
  const { id, label, required, displayLabel, rawErrors = [], description, rawDescription, children, uiSchema } = props;
  const isCheckbox = uiSchema?.["ui:widget"] === "checkbox";
  const hasError = rawErrors.length > 0;

  return (
    // Tailwind preset sizes (not arbitrary `text-[Npx]`) so each
    // class's matching line-height applies.
    <div className="flex flex-col gap-1.5">
      {displayLabel && !isCheckbox && (
        <label
          htmlFor={id}
          className={cn("text-sm font-medium", hasError && "text-destructive")}
        >
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </label>
      )}
      {children}
      {displayLabel && rawDescription && !isCheckbox && (
        <span className={cn("text-xs text-muted-foreground", hasError && "text-destructive")}>
          {description}
        </span>
      )}
    </div>
  );
}

/**
 * Recursively flattens Pydantic-style `anyOf: [{type: "X"}, {type: "null"}]`
 * into `{ type: ["X", "null"] }` so RJSF renders a normal input instead of a dropdown.
 */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return schema;

  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const anyOf = schema.anyOf as Record<string, unknown>[];
    const nullIndex = anyOf.findIndex((s) => s.type === "null");
    if (nullIndex !== -1) {
      const otherSchema = anyOf[nullIndex === 0 ? 1 : 0];
      const { anyOf: _anyOf, ...restSchema } = schema;
      const otherType = otherSchema.type;
      
      if (typeof otherType === "string") {
        const merged = {
          ...restSchema,
          ...otherSchema,
          type: [otherType, "null"],
        };
        return sanitizeSchema(merged as Record<string, unknown>);
      }
    }
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === "object" && item !== null ? sanitizeSchema(item as Record<string, unknown>) : item
      );
    } else if (typeof v === "object" && v !== null) {
      result[k] = sanitizeSchema(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// Generate UI schema

function generateUiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return {};
  if (schema.type === "object") {
    if (!schema.properties || Object.keys(schema.properties as object).length === 0) {
      return { "ui:field": "json" };
    }
    const uiSchema: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      const fieldUi = generateUiSchema(propSchema as Record<string, unknown>);
      if (Object.keys(fieldUi).length > 0) uiSchema[key] = fieldUi;
    }
    return uiSchema;
  }
  if (schema.type === "array" && schema.items) {
    const itemsUi = generateUiSchema(schema.items as Record<string, unknown>);
    if (Object.keys(itemsUi).length > 0) return { items: itemsUi };
  }
  return {};
}

// Main page

type InputTab = "form" | "json" | "schema";

type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

interface TaskView {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  retentionMs: number | null;
  suggestedPollIntervalMs?: number;
  ttl: number | null;
  pollInterval?: number;
  pollCount?: number;
  result?: unknown;
  raw: Record<string, unknown>;
  extensions: Record<string, unknown>;
}

interface TaskListPage {
  tasks: TaskView[];
  nextCursor?: string;
}

interface TaskPollRecord {
  seq: number;
  timestamp: string;
  status: TaskStatus;
  statusMessage?: string;
  suggestedPollIntervalMs?: number;
  retentionMs?: number | null;
  data: TaskView;
}

/** Consolidated input-editor state — reset together on tool switch. */
interface InputState {
  activeTab: InputTab;
  jsonInput: string;
  jsonError: string | null;
  formData: Record<string, unknown>;
}

const EMPTY_INPUT: InputState = {
  activeTab: "form",
  jsonInput: "{}",
  jsonError: null,
  formData: {},
};

const TASK_STATUS_STYLES: Record<TaskStatus, string> = {
  working: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  input_required: "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  completed: "bg-green-500/20 text-green-600 dark:text-green-400",
  failed: "bg-red-500/20 text-red-600 dark:text-red-400",
  cancelled: "bg-muted text-muted-foreground",
};

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  working: "Working",
  input_required: "Input Required",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function TaskStatusBadge({ status }: { status: TaskStatus }): ReactNode {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold leading-none",
        TASK_STATUS_STYLES[status],
      )}
    >
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

function TaskBannerCard({
  task,
  snapshotSeq,
  onSelectTask,
}: {
  task: TaskView;
  snapshotSeq?: number | null;
  onSelectTask: (taskId: string) => void;
}): ReactNode {
  const isCompleted = task.status === "completed";
  const isFailed = task.status === "failed";
  const isCancelled = task.status === "cancelled";
  const isSnapshot = snapshotSeq !== undefined && snapshotSeq !== null;

  return (
    <div className="mb-3 flex items-center justify-between rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs text-foreground">
      <div className="flex items-center gap-1.5 min-w-0">
        {isCompleted ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : isFailed || isCancelled ? (
          <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : isSnapshot ? (
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium shrink-0 text-muted-foreground">Task:</span>
        <button
          type="button"
          onClick={() => onSelectTask(task.taskId)}
          className="cursor-pointer rounded bg-background/60 px-1 font-mono text-[10px] text-foreground hover:bg-background hover:underline transition-colors truncate max-w-[240px]"
          title="View Task"
        >
          {task.taskId}
        </button>
        {isSnapshot && (
          <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            #{snapshotSeq}
          </span>
        )}
      </div>
      <div className="shrink-0 ml-2">
        <TaskStatusBadge status={task.status} />
      </div>
    </div>
  );
}

/** Consolidated execution lifecycle state — reset together on tool switch and before each run. */
interface ExecState {
  executing: boolean;
  result: unknown | null;
  execError: string | null;
  executedArgs: Record<string, unknown> | null;
  durationMs: number | null;
}

const IDLE_EXEC: ExecState = {
  executing: false,
  result: null,
  execError: null,
  executedArgs: null,
  durationMs: null,
};

// History dropdown — auto-saved on each successful execution

interface HistoryDropdownProps {
  serverId: string;
  toolName: string | null;
  onLoad: (args: Record<string, unknown>, result?: unknown, durationMs?: number) => void;
}

function HistoryDropdown({ serverId, toolName, onLoad }: HistoryDropdownProps): ReactNode {
  const [snapshots, setSnapshots] = useState<ToolExecutionSnapshot[]>(
    () => (toolName ? loadSnapshots(serverId, toolName) : []),
  );

  // Refresh snapshots when the active tool changes.
  const [prevToolName, setPrevToolName] = useState(toolName);
  if (toolName !== prevToolName) {
    setPrevToolName(toolName);
    setSnapshots(toolName ? loadSnapshots(serverId, toolName) : []);
  }

  function refresh(): void {
    if (toolName) setSnapshots(loadSnapshots(serverId, toolName));
  }

  function handleTogglePin(e: React.MouseEvent, id: string): void {
    e.stopPropagation();
    if (!toolName) return;
    togglePin(serverId, toolName, id);
    refresh();
  }

  if (!toolName || snapshots.length === 0) return null;

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) refresh(); }}>
      <DropdownMenuTrigger
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        Recent
        {snapshots.length > 0 && (
          <span className="text-[10px] tabular-nums opacity-70">({snapshots.length})</span>
        )}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {snapshots.map((snap) => (
          <DropdownMenuItem
            key={snap.id}
            onClick={() => onLoad(snap.args, snap.result, snap.durationMs)}
            className="group flex items-center gap-1.5"
          >
            <span className={cn("flex-1 truncate text-xs", snap.pinned && "font-medium")}>{snap.name}</span>
            {snap.durationMs !== undefined && (
              <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
                {snap.durationMs < 1000 ? `${snap.durationMs} ms` : `${(snap.durationMs / 1000).toFixed(1)} s`}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => handleTogglePin(e, snap.id)}
              className={cn(
                "shrink-0 transition-opacity",
                snap.pinned
                  ? "text-amber-500"
                  : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500",
              )}
              title={snap.pinned ? "Unpin" : "Pin"}
            >
              <Star className={cn("h-3 w-3", snap.pinned && "fill-amber-500")} />
            </button>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `key={serverId}` gives automatic state reset on server switch
 *  (every `useState` inside `<ServerView>` re-initialises). */
export default function McpToolTestPage(): ReactNode {
  const { serverId } = useParams<{ serverId: string }>();
  return <ServerView key={serverId} serverId={serverId} />;
}

function ServerView({ serverId }: { serverId: string }): ReactNode {
  const router = useRouter();
  const tz = useDisplayTimezone();

  // Tool metadata
  const [serverTools, setServerTools] = useState<McpToolSnapshot[]>([]);
  const [serverPrompts, setServerPrompts] = useState<McpPromptSnapshot[]>([]);
  const [serverResources, setServerResources] = useState<McpResourceSnapshot[]>([]);
  const [serverCapabilities, setServerCapabilities] = useState<Record<string, unknown> | null>(null);
  const [serverName, setServerName] = useState("");
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [search, setSearch] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"tools" | "prompts" | "resources" | "tasks">("tools");

  // Selection is component-local (not in the URL) — fresh mount /
  // refresh always lands on the first tool. Keeps the URL shape
  // simple at `/mcp/test/<serverId>`.
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);

  const [input, setInput] = useState<InputState>(EMPTY_INPUT);
  const [exec, setExec] = useState<ExecState>(IDLE_EXEC);
  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);
  const [resultTab, setResultTab] = useState<"view" | "raw">("view");
  const [copied, setCopied] = useState<boolean>(false);
  const [snapshotTrigger, setSnapshotTrigger] = useState<number>(0);

  /** Per-tool state cache so switching tools preserves input + result. */
  const toolStateCache = useRef<Map<string, { input: InputState; exec: ExecState }>>(new Map());

  // Tasks tab state
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [, setTasksNextCursor] = useState<string | undefined>(undefined);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskView | null>(null);
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  const [pollHistory, setPollHistory] = useState<Record<string, TaskPollRecord[]>>({});
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const [selectedSnapshotSeq, setSelectedSnapshotSeq] = useState<number | null>(null);
  const selectedSnapshotSeqRef = useRef<number | null>(selectedSnapshotSeq);
  useEffect(() => {
    selectedSnapshotSeqRef.current = selectedSnapshotSeq;
  }, [selectedSnapshotSeq]);

  const inFlightPollsRef = useRef<Set<string>>(new Set());

  const [loadingTasks, setLoadingTasks] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [cancellingTask, setCancellingTask] = useState(false);

  // Load once: serverId is fixed for this <ServerView> instance
  // (outer Page keys on it).
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const res = await fetch(`/api/mcp-servers`);
        if (!res.ok || cancelled) return;
        const servers = await res.json();
        const server = servers.find((s: { id: string }) => s.id === serverId);
        if (!server || cancelled) return;
        setServerName(server.name);
        setServerTools(server.tools ?? []);
        setServerPrompts(server.prompts ?? []);
        setServerResources(server.resources ?? []);
        setServerCapabilities(server.serverCapabilities ?? null);
        // Default to tools tab, or prompts/resources if no tools
        if ((server.tools?.length ?? 0) === 0) {
          if ((server.prompts?.length ?? 0) > 0) setActiveTab("prompts");
          else if ((server.resources?.length ?? 0) > 0) setActiveTab("resources");
        }
      } catch { /* silent */ }
      if (!cancelled) setLoadingMeta(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [serverId]);

  // Task list fetching
  const fetchTasks = useCallback(async (): Promise<TaskView[]> => {
    setLoadingTasks(true);
    setTasksError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${serverId}/tasks`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTasksError(data.message ?? `Failed to load tasks (${res.status})`);
        return [];
      }
      const page: TaskListPage = await res.json();
      const remoteTasks = page.tasks ?? [];
      setTasks((prev) => {
        const map = new Map<string, TaskView>();
        for (const t of remoteTasks) {
          map.set(t.taskId, t);
        }
        for (const t of prev) {
          if (!map.has(t.taskId)) {
            map.set(t.taskId, t);
          } else {
            const remote = map.get(t.taskId)!;
            if (
              (t.status === "completed" || t.status === "failed" || t.status === "cancelled") &&
              remote.status === "working"
            ) {
              map.set(t.taskId, { ...remote, ...t });
            }
          }
        }
        return Array.from(map.values());
      });
      setTasksNextCursor(page.nextCursor);
      return remoteTasks;
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "Failed to load tasks");
      return [];
    } finally {
      setLoadingTasks(false);
    }
  }, [serverId]);

  // Fetch single task detail (guarded against concurrent in-flight requests for the same taskId)
  const fetchTaskDetail = useCallback(async (taskId: string): Promise<TaskView | null> => {
    if (inFlightPollsRef.current.has(taskId)) {
      return null;
    }
    inFlightPollsRef.current.add(taskId);
    try {
      const res = await fetch(`/api/mcp-servers/${serverId}/tasks/${taskId}`);
      if (!res.ok) return null;
      const detail: TaskView = await res.json();
      if (detail.taskId === selectedTaskIdRef.current) {
        if (selectedSnapshotSeqRef.current === null) {
          setSelectedTask(detail);
        }
      }
      setTasks((prev) =>
        prev.map((t) => (t.taskId === detail.taskId ? { ...t, ...detail } : t)),
      );
      setPollHistory((prev) => {
        const list = prev[taskId] ?? [];
        const last = list[list.length - 1];
        // Prevent recording duplicate terminal snapshots if already terminal
        if (last && (last.status === "completed" || last.status === "failed" || last.status === "cancelled")) {
          return prev;
        }
        const nextSeq = list.length + 1;
        const rec: TaskPollRecord = {
          seq: nextSeq,
          timestamp: new Date().toISOString(),
          status: detail.status,
          statusMessage: detail.statusMessage,
          suggestedPollIntervalMs: detail.suggestedPollIntervalMs ?? detail.pollInterval,
          retentionMs: detail.retentionMs,
          data: detail,
        };
        return {
          ...prev,
          [taskId]: [...list, rec],
        };
      });
      return detail;
    } catch { /* silent — detail refresh is best-effort */ return null; }
    finally {
      inFlightPollsRef.current.delete(taskId);
    }
  }, [serverId, setSelectedTask]);

  // Fetch tasks when switching to tasks tab
  useEffect(() => {
    if (activeTab !== "tasks") return;
    let cancelled = false;
    void (async () => {
      const list = await fetchTasks();
      if (!cancelled && list.length > 0 && !selectedTaskId) {
        setSelectedTaskId(list[0].taskId);
        setSelectedTask(list[0]);
        setSelectedSnapshotSeq(null);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, fetchTasks]); // eslint-disable-line react-hooks/exhaustive-deps -- selectedTaskId read only at fetch time

  // If the current tool execution is tied to a task, resolve the latest task state
  const activeTaskResult = useMemo((): TaskView | null => {
    if (
      typeof exec.result === "object" &&
      exec.result !== null &&
      (exec.result as Record<string, unknown>).mode === "task"
    ) {
      const tid = (exec.result as Record<string, unknown>).taskId;
      if (typeof tid !== "string") return null;
      return tasks.find((t) => t.taskId === tid) ?? null;
    }
    return null;
  }, [exec.result, tasks]);

  // Auto-poll non-terminal tasks (runs in background across tabs until all active tasks complete)
  useEffect(() => {
    // Only poll tasks whose live status in `tasks` is active.
    // Never inspect `selectedTask` because it can be an immutable historical snapshot.
    const activeTasks = tasks.filter(
      (t) => t.status === "working" || t.status === "input_required",
    );
    if (activeTasks.length === 0) return;

    // Calculate poll interval from server hints (suggestedPollIntervalMs or pollInterval)
    let intervalMs = 5000;
    const intervals = activeTasks
      .map((t) => t.suggestedPollIntervalMs ?? t.pollInterval)
      .filter((v): v is number => typeof v === "number" && v > 0);
    if (intervals.length > 0) {
      intervalMs = Math.min(...intervals);
    }
    // Respect server interval, with 1s minimum safety bound
    intervalMs = Math.max(intervalMs, 1000);

    const timer = setInterval(() => {
      for (const t of activeTasks) {
        void fetchTaskDetail(t.taskId);
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [tasks, fetchTaskDetail]);

  // Cancel task
  const handleCancelTask = useCallback(async (taskId: string) => {
    setCancellingTask(true);
    try {
      const res = await fetch(`/api/mcp-servers/${serverId}/tasks/${taskId}/cancel`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTasksError(data.message ?? `Failed to cancel task (${res.status})`);
      } else {
        // Refresh after cancel
        await fetchTasks();
        if (selectedTaskId) await fetchTaskDetail(selectedTaskId);
      }
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "Failed to cancel task");
    } finally {
      setCancellingTask(false);
    }
  }, [serverId, selectedTaskId, fetchTasks, fetchTaskDetail]);

  // Active tool: picked one, else first available, else null.
  const tool: McpToolSnapshot | null = useMemo(() => {
    if (selectedToolName !== null) {
      const picked = serverTools.find((t) => t.name === selectedToolName);
      if (picked) return picked;
    }
    return serverTools[0] ?? null;
  }, [serverTools, selectedToolName]);

  // Case-insensitive substring search on name + description.
  const filteredTools: McpToolSnapshot[] = useMemo(() => {
    const q: string = search.trim().toLowerCase();
    if (q.length === 0) return serverTools;
    return serverTools.filter((t) => {
      if (t.name.toLowerCase().includes(q)) return true;
      const desc: string = t.description ?? "";
      return desc.toLowerCase().includes(q);
    });
  }, [serverTools, search]);

  // Filter prompts by name + description
  const filteredPrompts: McpPromptSnapshot[] = useMemo(() => {
    const q: string = search.trim().toLowerCase();
    if (q.length === 0) return serverPrompts;
    return serverPrompts.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      const desc: string = p.description ?? "";
      return desc.toLowerCase().includes(q);
    });
  }, [serverPrompts, search]);

  // Filter resources by name + uri + description
  const filteredResources: McpResourceSnapshot[] = useMemo(() => {
    const q: string = search.trim().toLowerCase();
    if (q.length === 0) return serverResources;
    return serverResources.filter((r) => {
      if (r.uri.toLowerCase().includes(q)) return true;
      if (r.name?.toLowerCase().includes(q)) return true;
      const desc: string = r.description ?? "";
      return desc.toLowerCase().includes(q);
    });
  }, [serverResources, search]);

  // Filter tasks by taskId + status + statusMessage
  const filteredTasks: TaskView[] = useMemo(() => {
    const q: string = search.trim().toLowerCase();
    if (q.length === 0) return tasks;
    return tasks.filter((t) => {
      if (t.taskId.toLowerCase().includes(q)) return true;
      if (t.status.toLowerCase().includes(q)) return true;
      const msg: string = t.statusMessage ?? "";
      return msg.toLowerCase().includes(q);
    });
  }, [tasks, search]);

  // Determine which tabs to show based on server capabilities
  const hasPrompts = serverCapabilities?.prompts === true || serverPrompts.length > 0;
  const hasResources = serverCapabilities?.resources === true || serverResources.length > 0;
  const hasTasksCapability = serverCapabilities?.tasks === true
    || (serverCapabilities?.extensions as Record<string, unknown>)?.["io.modelcontextprotocol/tasks"] !== undefined;

  // Execute tool
  const activeToolName: string | null = tool?.name ?? null;
  const handleExecute = useCallback(async () => {
    if (activeToolName === null) return;
    setExec({ executing: true, result: null, execError: null, executedArgs: null, durationMs: null });

    let args: Record<string, unknown>;
    if (input.activeTab === "json") {
      try {
        args = JSON.parse(input.jsonInput);
      } catch {
        setInput((prev) => ({ ...prev, jsonError: "Invalid JSON" }));
        setExec(IDLE_EXEC);
        return;
      }
    } else {
      args = input.formData;
    }

    const startTime = performance.now();
    try {
      const res = await fetch(`/api/mcp-servers/${serverId}/call-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: activeToolName, args }),
      });
      const data = await res.json();
      const durationMs = Math.round(performance.now() - startTime);

      if (!res.ok) {
        const baseErr = data.message ?? data.error ?? "Execution failed";
        const execError = data.code ? `[${data.code}] ${baseErr}` : baseErr;
        setExec({ executing: false, result: null, execError, executedArgs: null, durationMs });
      } else if (data.mode === "task") {
        setExec({ executing: false, result: data, execError: null, executedArgs: args, durationMs });
        saveSnapshot(
          serverId,
          activeToolName,
          formatTimestamp(new Date(), tz, "datetimePrecise"),
          args,
          data,
          durationMs,
          data.snapshotMaxBytes,
        );
        setSnapshotTrigger((prev) => prev + 1);
        const initialTask = data.initialTask as TaskView | undefined;
        const optimisticTask: TaskView = {
          taskId: data.taskId,
          status: initialTask?.status ?? "working",
          statusMessage: initialTask?.statusMessage ?? `Started by ${activeToolName}`,
          createdAt: initialTask?.createdAt ?? new Date().toISOString(),
          retentionMs: initialTask?.retentionMs ?? null,
          suggestedPollIntervalMs: initialTask?.suggestedPollIntervalMs ?? initialTask?.pollInterval,
          pollInterval: initialTask?.pollInterval,
          ttl: initialTask?.ttl ?? null,
          raw: initialTask?.raw ?? {},
          extensions: initialTask?.extensions ?? {},
        };
        const initialRecord: TaskPollRecord = {
          seq: 1,
          timestamp: new Date().toISOString(),
          status: optimisticTask.status,
          statusMessage: optimisticTask.statusMessage,
          suggestedPollIntervalMs: optimisticTask.suggestedPollIntervalMs,
          retentionMs: optimisticTask.retentionMs,
          data: optimisticTask,
        };
        setPollHistory((prev) => ({
          ...prev,
          [data.taskId]: [initialRecord],
        }));
        setTasks((prev) => {
          if (prev.some((t) => t.taskId === data.taskId)) return prev;
          return [optimisticTask, ...prev];
        });
        setSelectedTask(optimisticTask);
        setSelectedTaskId(data.taskId);
        setSelectedSnapshotSeq(null);
      } else {
        setExec({ executing: false, result: data.result, execError: null, executedArgs: args, durationMs });
        // Auto-save input args, result, and durationMs to history on successful execution.
        saveSnapshot(
          serverId,
          activeToolName,
          formatTimestamp(new Date(), tz, "datetimePrecise"),
          args,
          data.result,
          durationMs,
          data.snapshotMaxBytes,
        );
        setSnapshotTrigger((prev) => prev + 1);
      }
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      setExec({
        executing: false,
        result: null,
        execError: err instanceof Error ? err.message : "Unexpected error",
        executedArgs: null,
        durationMs,
      });
    }
  }, [input.activeTab, input.jsonInput, input.formData, serverId, activeToolName, tz, setSelectedTaskId, setSelectedTask, setSelectedSnapshotSeq]);

  const schema = useMemo(() => {
    const raw = (tool?.input_schema as Record<string, unknown>) ?? {};
    return sanitizeSchema(raw);
  }, [tool]);
  const uiSchema = generateUiSchema(schema);

  // Effective result resolves task outcome if this was a task-mode execution
  const effectiveResult = useMemo(() => {
    if (activeTaskResult && activeTaskResult.status === "completed") {
      return (
        activeTaskResult.result ??
        (activeTaskResult.raw as Record<string, unknown>)?.result ??
        activeTaskResult.raw
      );
    }
    return exec.result;
  }, [activeTaskResult, exec.result]);

  const taskError = useMemo(() => {
    if (!activeTaskResult) return null;
    if (activeTaskResult.status === "failed") {
      const err = (activeTaskResult.raw as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
      return (typeof err?.message === "string" ? err.message : null) ?? activeTaskResult.statusMessage ?? "Task failed";
    }
    if (activeTaskResult.status === "cancelled") {
      return "Task was cancelled";
    }
    return null;
  }, [activeTaskResult]);

  // Copilot shared-state: expose test page context so the agent can
  // help build tool params or analyse execution results.
  const getCurrentData = useCallback(
    () => ({
      server: {
        id: serverId,
        name: serverName,
      },
      selectedTool: tool
        ? {
            name: activeToolName,
            description: tool.description ?? null,
            inputSchema: schema,
            args: input.formData,
          }
        : null,
      execution: {
        status: exec.executing
          ? "executing"
          : exec.execError || taskError
            ? "failed"
            : activeTaskResult
              ? activeTaskResult.status === "completed"
                ? "succeeded"
                : "executing"
              : exec.result !== null
                ? "succeeded"
                : "idle",
        durationMs: exec.durationMs,
        result: effectiveResult,
        error: exec.execError ?? taskError,
      },
    }) as Record<string, unknown>,
    [
      serverId,
      serverName,
      tool,
      activeToolName,
      schema,
      input.formData,
      exec.executing,
      exec.execError,
      exec.result,
      exec.durationMs,
      taskError,
      activeTaskResult,
      effectiveResult,
    ],
  );
  const applyDraft = useCallback((draft: Record<string, unknown>) => {
    const applied: string[] = [];
    let targetArgs: Record<string, unknown> | null = null;
    if (
      draft.selectedTool &&
      typeof draft.selectedTool === "object" &&
      !Array.isArray(draft.selectedTool)
    ) {
      const st = draft.selectedTool as Record<string, unknown>;
      if (st.args && typeof st.args === "object" && !Array.isArray(st.args)) {
        targetArgs = st.args as Record<string, unknown>;
        applied.push("args");
      }
    } else if (
      draft.args &&
      typeof draft.args === "object" &&
      !Array.isArray(draft.args)
    ) {
      targetArgs = draft.args as Record<string, unknown>;
      applied.push("args");
    } else if (typeof draft.jsonInput === "string") {
      try {
        const parsed = JSON.parse(draft.jsonInput);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          targetArgs = parsed as Record<string, unknown>;
          applied.push("jsonInput");
        }
      } catch {
        /* ignore invalid JSON */
      }
    }
    if (targetArgs !== null) {
      setInput((prev) => ({
        ...prev,
        formData: targetArgs!,
        jsonInput: JSON.stringify(targetArgs, null, 2),
        jsonError: null,
      }));
    }
    if (typeof draft.selectedToolName === "string") {
      applied.push("selectedToolName");
    }
    return applied;
  }, []);

  useCopilotDraft({
    resourceType: "mcp",
    resourceId: serverId ?? null,
    isReadOnly: false,
    getCurrentData,
    applyDraft,
  });

  // Active task and payload resolution for the right pane
  const displayTask: TaskView | null = useMemo(() => {
    if (activeTab === "tasks") {
      return selectedTask;
    }
    return activeTaskResult;
  }, [activeTab, selectedTask, activeTaskResult]);

  const displayResult = useMemo(() => {
    if (displayTask) {
      if (displayTask.status === "completed") {
        return (
          displayTask.result ??
          (displayTask.raw as Record<string, unknown>)?.result ??
          displayTask.raw
        );
      }
      return (
        (displayTask.raw as Record<string, unknown>)?.result ??
        displayTask.raw
      );
    }
    return exec.result;
  }, [displayTask, exec.result]);

  const displayRawJson = useMemo(() => {
    if (displayTask) {
      return Object.keys(displayTask.raw).length > 0 ? displayTask.raw : displayTask;
    }
    return exec.result;
  }, [displayTask, exec.result]);

  const displayError = useMemo(() => {
    if (displayTask) {
      if (displayTask.status === "failed") {
        const err = (displayTask.raw as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
        return (typeof err?.message === "string" ? err.message : null) ?? displayTask.statusMessage ?? "Task failed";
      }
      if (displayTask.status === "cancelled") {
        return "Task was cancelled";
      }
      return null;
    }
    return exec.execError;
  }, [displayTask, exec.execError]);

  const durationStr = useMemo(() => {
    if (activeTab === "tasks") return null;
    if (exec.durationMs === null) return null;
    if (exec.durationMs < 1000) return `${exec.durationMs} ms`;
    return `${(exec.durationMs / 1000).toFixed(2)} s`;
  }, [activeTab, exec.durationMs]);

  const resultSizeStr = useMemo(() => {
    const target = resultTab === "raw" ? displayRawJson : displayResult;
    if (target === null || target === undefined) return null;
    if (
      typeof target === "object" &&
      (target as Record<string, unknown>).mode === "task" &&
      (!displayTask || displayTask.status !== "completed")
    ) {
      return null;
    }
    try {
      const str = JSON.stringify(target);
      const bytes = new TextEncoder().encode(str).length;
      if (bytes < 1024) return `${bytes} B`;
      return `${(bytes / 1024).toFixed(1)} KB`;
    } catch {
      return null;
    }
  }, [resultTab, displayRawJson, displayResult, displayTask]);

  // Auto-save completed task result to snapshot history
  const savedCompletedTasksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      activeTaskResult &&
      activeTaskResult.status === "completed" &&
      activeToolName &&
      exec.executedArgs &&
      !savedCompletedTasksRef.current.has(activeTaskResult.taskId)
    ) {
      savedCompletedTasksRef.current.add(activeTaskResult.taskId);
      const finalResult =
        activeTaskResult.result ??
        (activeTaskResult.raw as Record<string, unknown>)?.result ??
        activeTaskResult.raw;
      saveSnapshot(
        serverId,
        activeToolName,
        formatTimestamp(new Date(), tz, "datetimePrecise"),
        exec.executedArgs,
        finalResult,
        exec.durationMs ?? undefined,
      );
      setSnapshotTrigger((prev) => prev + 1);
    }
  }, [activeTaskResult, activeToolName, exec.executedArgs, exec.durationMs, serverId, tz]);

  /** Save current tool state to cache, then restore (or reset) the target tool's state. */
  function handleSelectTool(name: string): void {
    if (name === activeToolName) return;
    // Persist current tool's state before switching.
    if (activeToolName) {
      toolStateCache.current.set(activeToolName, { input, exec });
    }
    // Restore cached state for the target tool, or start fresh.
    const cached = toolStateCache.current.get(name);
    setInput(cached?.input ?? EMPTY_INPUT);
    setExec(cached?.exec ?? IDLE_EXEC);
    setSelectedToolName(name);
  }

  const executeDisabled: boolean =
    tool === null || (input.activeTab === "json" && input.jsonError !== null);

  // Cmd/Ctrl+Enter shortcut on window so it fires from any focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Enter") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (exec.executing || executeDisabled) return;
      e.preventDefault();
      void handleExecute();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleExecute, exec.executing, executeDisabled]);

  if (loadingMeta) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header row. */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => router.push("/mcp")}
            aria-label="Back"
            data-testid="mcp-test-back-button"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <h2
            className="text-xs font-semibold tracking-tight text-foreground truncate"
            data-testid="mcp-test-heading"
          >
            {tool ? `${serverName} / ${tool.name}` : (serverName || "Select a tool")}
          </h2>
        </div>
        {tool && (
          <div className="shrink-0 flex items-center">
            <HistoryDropdown
              key={`${activeToolName}:${snapshotTrigger}`}
              serverId={serverId}
              toolName={activeToolName}
              onLoad={(args, result, durationMs) => {
                setInput((prev) => ({ ...prev, formData: args, jsonInput: JSON.stringify(args, null, 2) }));
                if (result !== undefined) {
                  setExec({ executing: false, result, execError: null, executedArgs: args, durationMs: durationMs ?? null });
                } else {
                  setExec(IDLE_EXEC);
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Three-column content (tool list + input + result). */}
      <div className="flex flex-1 min-h-0">
        {/* Tool list — search box on top + tabs + scrollable list. */}
        <div className="flex flex-[3] flex-col border-r min-w-0">
          <div className="border-b bg-muted/40 px-2 py-1.5 space-y-1.5">
            <div className="flex h-7 items-center gap-1.5 rounded-md border bg-background px-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search …"
                aria-label={`Search ${activeTab}`}
                data-testid="mcp-tool-search-input"
                className="h-full flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60 min-w-0"
              />
              {search.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {/* Dynamic tabs */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveTab("tools")}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  activeTab === "tools"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                Tools ({serverTools.length})
              </button>
              {hasPrompts && (
                <button
                  type="button"
                  onClick={() => setActiveTab("prompts")}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    activeTab === "prompts"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                  )}
                >
                  Prompts ({serverPrompts.length})
                </button>
              )}
              {hasResources && (
                <button
                  type="button"
                  onClick={() => setActiveTab("resources")}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    activeTab === "resources"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                  )}
                >
                  Resources ({serverResources.length})
                </button>
              )}
              {hasTasksCapability && (
                <button
                  type="button"
                  onClick={() => setActiveTab("tasks")}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    activeTab === "tasks"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                  )}
                >
                  Tasks ({tasks.length})
                </button>
              )}
            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            {activeTab === "tools" && (
              <>
                {serverTools.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No tools discovered yet. Refresh the server in the left panel to scan.
                  </div>
                ) : filteredTools.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No tools match &ldquo;{search}&rdquo;.
                  </div>
                ) : (
                  <ul className="flex flex-col">
                    {filteredTools.map((t) => {
                      const active: boolean = t.name === activeToolName;
                      return (
                        <li key={t.name}>
                          <button
                            type="button"
                            onClick={() => handleSelectTool(t.name)}
                            aria-pressed={active}
                            data-testid="mcp-tool-item"
                            data-tool-name={t.name}
                            className={cn(
                              "block w-full border-b border-border/40 px-3 py-2 text-left transition-colors",
                              active
                                ? "bg-accent"
                                : "hover:bg-muted/50",
                            )}
                          >
                            <div className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  "truncate font-mono text-sm font-medium",
                                  active ? "text-accent-foreground" : "text-foreground/90",
                                )}
                              >
                                {t.name}
                              </span>
                              {t.execution?.taskSupport && t.execution.taskSupport !== "forbidden" && (
                                <span
                                  className="shrink-0 rounded bg-blue-500/20 px-1 py-0.5 text-[9px] font-semibold leading-none text-blue-600 dark:text-blue-400"
                                  title={`Task support: ${t.execution.taskSupport}`}
                                >
                                  T
                                </span>
                              )}
                            </div>
                            {t.description && (
                              <div
                                className={cn(
                                  "mt-0.5 line-clamp-2 text-xs",
                                  active ? "text-accent-foreground/70" : "text-muted-foreground",
                                )}
                              >
                                {t.description}
                              </div>
                            )}
                          </button>
                    </li>
                  );
                })}
              </ul>
            )}
              </>
            )}
            {activeTab === "prompts" && (
              <>
                {serverPrompts.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No prompts available.
                  </div>
                ) : filteredPrompts.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No prompts match &ldquo;{search}&rdquo;.
                  </div>
                ) : (
                  <ul className="flex flex-col">
                    {filteredPrompts.map((p) => (
                      <li key={p.name}>
                        <div
                          className="block w-full border-b border-border/40 px-3 py-2 text-left"
                        >
                          <div className="truncate font-mono text-sm font-medium text-foreground/90">
                            {p.name}
                          </div>
                          {p.description && (
                            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {p.description}
                            </div>
                          )}
                          {p.arguments && p.arguments.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {p.arguments.map((arg) => (
                                <span
                                  key={arg.name}
                                  className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  {arg.name}{arg.required ? "*" : ""}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {activeTab === "resources" && (
              <>
                {serverResources.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No resources available.
                  </div>
                ) : filteredResources.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No resources match &ldquo;{search}&rdquo;.
                  </div>
                ) : (
                  <ul className="flex flex-col">
                    {filteredResources.map((r) => (
                      <li key={r.uri}>
                        <div
                          className="block w-full border-b border-border/40 px-3 py-2 text-left"
                        >
                          <div className="truncate font-mono text-sm font-medium text-foreground/90">
                            {r.name || r.uri}
                          </div>
                          {r.name && r.uri !== r.name && (
                            <div className="mt-0.5 truncate text-[10px] font-mono text-muted-foreground/60">
                              {r.uri}
                            </div>
                          )}
                          {r.description && (
                            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {r.description}
                            </div>
                          )}
                          {r.mimeType && (
                            <div className="mt-1">
                              <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                {r.mimeType}
                              </span>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {activeTab === "tasks" && (
              <>
                {tasksError && (
                  <div className="px-3 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/20">
                    {tasksError}
                  </div>
                )}
                {tasks.length === 0 && !loadingTasks ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No active tasks on this server.
                  </div>
                ) : filteredTasks.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    No tasks match &ldquo;{search}&rdquo;.
                  </div>
                ) : (
                  <ul className="flex flex-col">
                    {filteredTasks.map((t) => {
                      const isTaskSelected = t.taskId === selectedTaskId;
                      const isExpanded = expandedTaskIds.has(t.taskId);
                      const isActive = t.status === "working" || t.status === "input_required";

                      const history = pollHistory[t.taskId] && pollHistory[t.taskId].length > 0
                        ? pollHistory[t.taskId]
                        : [
                            {
                              seq: 1,
                              timestamp: t.lastUpdatedAt || t.createdAt || new Date().toISOString(),
                              status: t.status,
                              statusMessage: t.statusMessage,
                              suggestedPollIntervalMs: t.suggestedPollIntervalMs ?? t.pollInterval,
                              retentionMs: t.retentionMs,
                              data: t,
                            },
                          ];

                      return (
                        <li key={t.taskId} className="border-b border-border/40">
                          {/* Parent Task Card */}
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              setSelectedTaskId(t.taskId);
                              setSelectedTask(t);
                              setSelectedSnapshotSeq(null);
                              if ((pollHistory[t.taskId]?.length ?? 0) === 0) {
                                void fetchTaskDetail(t.taskId);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelectedTaskId(t.taskId);
                                setSelectedTask(t);
                                setSelectedSnapshotSeq(null);
                                if ((pollHistory[t.taskId]?.length ?? 0) === 0) {
                                  void fetchTaskDetail(t.taskId);
                                }
                              }
                            }}
                            className={cn(
                              "block w-full px-3 py-2 text-left transition-colors cursor-pointer select-none",
                              isTaskSelected && selectedSnapshotSeq === null
                                ? "bg-accent"
                                : "hover:bg-muted/50",
                            )}
                          >
                            {/* Row 1: [Chevron] [task id] [Cancel button if active] [status] */}
                            <div className="flex items-center justify-between gap-1.5 min-w-0">
                              <div className="flex items-center gap-1 min-w-0 flex-1">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedTaskIds((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(t.taskId)) {
                                        next.delete(t.taskId);
                                      } else {
                                        next.add(t.taskId);
                                        if ((pollHistory[t.taskId]?.length ?? 0) === 0) {
                                          void fetchTaskDetail(t.taskId);
                                        }
                                      }
                                      return next;
                                    });
                                  }}
                                  className="p-1 -ml-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                                  aria-label={isExpanded ? "Collapse task" : "Expand task"}
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                                  )}
                                </button>
                                <span
                                  className={cn(
                                    "truncate font-mono text-xs",
                                    isTaskSelected && selectedSnapshotSeq === null
                                      ? "text-accent-foreground font-semibold"
                                      : "text-foreground/90 font-medium",
                                  )}
                                >
                                  {t.taskId.length > 16 ? `${t.taskId.slice(0, 16)}...` : t.taskId}{" "}
                                  <span
                                    className={cn(
                                      "font-sans font-normal text-[11px]",
                                      isTaskSelected && selectedSnapshotSeq === null
                                        ? "text-accent-foreground/70"
                                        : "text-muted-foreground",
                                    )}
                                  >
                                    ({history.length})
                                  </span>
                                </span>
                              </div>
                              <div className="flex items-center gap-1 shrink-0 ml-2">
                                {isActive && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-5 px-1.5 text-[10px] font-medium text-destructive border-destructive/40 bg-destructive/5 hover:bg-destructive/15 hover:text-destructive hover:border-destructive/60 cursor-pointer"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleCancelTask(t.taskId);
                                    }}
                                    disabled={cancellingTask}
                                  >
                                    Cancel
                                  </Button>
                                )}
                                <TaskStatusBadge status={t.status} />
                              </div>
                            </div>

                            {/* Row 2: statusMessage (left) + time (right) */}
                            <div
                              className={cn(
                                "mt-0.5 flex items-center justify-between gap-1 text-[11px] min-h-[16px]",
                                isTaskSelected && selectedSnapshotSeq === null
                                  ? "text-accent-foreground/70"
                                  : "text-muted-foreground",
                              )}
                            >
                              <span className="truncate flex-1 min-w-0">
                                {t.statusMessage || "—"}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 text-[10px] tabular-nums ml-2",
                                  isTaskSelected && selectedSnapshotSeq === null
                                    ? "text-accent-foreground/60"
                                    : "text-muted-foreground/60",
                                )}
                              >
                                {t.createdAt
                                  ? formatTimestamp(new Date(t.createdAt), tz, "datetimePrecise")
                                  : "—"}
                              </span>
                            </div>
                          </div>

                          {/* Sub-tree: Polling history snapshots */}
                          {isExpanded && (
                            <div className="border-t border-border/20 bg-muted/15">
                              {history.map((rec) => {
                                const isSnapshotSelected =
                                  isTaskSelected && selectedSnapshotSeq === rec.seq;
                                const recIntervalSec = Math.max(
                                  1,
                                  Math.round((rec.suggestedPollIntervalMs ?? t.suggestedPollIntervalMs ?? t.pollInterval ?? 2000) / 1000),
                                );

                                return (
                                  <button
                                    key={rec.seq}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedTaskId(t.taskId);
                                      setSelectedTask(rec.data);
                                      setSelectedSnapshotSeq(rec.seq);
                                    }}
                                    className={cn(
                                      "w-full text-left pl-6 pr-3 py-1.5 border-t border-border/10 transition-colors block",
                                      isSnapshotSelected ? "bg-accent/80" : "hover:bg-muted/40",
                                    )}
                                  >
                                    {/* Snapshot Row 1: [#seq] [time] [status] */}
                                    <div className="flex items-center justify-between gap-1.5">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <span
                                          className={cn(
                                            "font-mono text-[11px] font-semibold",
                                            isSnapshotSelected ? "text-accent-foreground" : "text-foreground",
                                          )}
                                        >
                                          #{rec.seq}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground tabular-nums">
                                          {formatTimestamp(new Date(rec.timestamp), tz, "timePrecise")}
                                        </span>
                                      </div>
                                      <div className="shrink-0 ml-2">
                                        <TaskStatusBadge status={rec.status} />
                                      </div>
                                    </div>

                                    {/* Snapshot Row 2: message (left) + poll interval 'xs' (right) */}
                                    <div
                                      className={cn(
                                        "mt-0.5 flex items-center justify-between gap-1 text-[11px] min-h-[16px]",
                                        isSnapshotSelected ? "text-accent-foreground/70" : "text-muted-foreground",
                                      )}
                                    >
                                      <span className="truncate flex-1 min-w-0">
                                        {rec.statusMessage || "—"}
                                      </span>
                                      <span
                                        className={cn(
                                          "shrink-0 text-[10px] tabular-nums ml-2",
                                          isSnapshotSelected ? "text-accent-foreground/60" : "text-muted-foreground/60",
                                        )}
                                      >
                                        {recIntervalSec}s
                                      </span>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </ScrollArea>
        </div>

        {/* Input column */}
        <div className="flex flex-[3] flex-col border-r min-w-0">
          {/* Input-mode tabs + Execute. */}
          <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
            <button
              type="button"
              onClick={() => setInput((prev) => ({ ...prev, activeTab: "form" }))}
              className={cn(
                "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                input.activeTab === "form"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              Form
            </button>
            <button
              type="button"
              onClick={() => setInput((prev) => ({ ...prev, activeTab: "json" }))}
              className={cn(
                "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                input.activeTab === "json"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              Json
            </button>
            <button
              type="button"
              onClick={() => setInput((prev) => ({ ...prev, activeTab: "schema" }))}
              className={cn(
                "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                input.activeTab === "schema"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              Schema
            </button>
            <div className="ml-auto flex items-center gap-1 relative z-10">
              <Button
                size="sm"
                className="h-6 gap-1.5 px-2.5 text-xs"
                onClick={handleExecute}
                disabled={exec.executing || executeDisabled}
                data-testid="mcp-run-button"
              >
                {exec.executing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-green-500 text-green-500" />
                )}
                Run
              </Button>
            </div>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3 h-full flex flex-col">
              {tool === null ? (
                <p className="text-xs text-muted-foreground">
                  {serverTools.length === 0
                    ? "This server has no discovered tools. Refresh it from the left panel to scan."
                    : "Pick a tool from the list to start testing."}
                </p>
              ) : input.activeTab === "form" ? (
                Object.keys(schema).length === 0 ? (
                  <p className="text-xs text-muted-foreground">This tool takes no input parameters.</p>
                ) : (
                  <Form
                    schema={schema}
                    uiSchema={uiSchema}
                    validator={validator}
                    formData={input.formData}
                    onChange={(e) => {
                      const fd = e.formData ?? {};
                      setInput((prev) => ({ ...prev, formData: fd, jsonInput: JSON.stringify(fd, null, 2) }));
                    }}
                    templates={{ FieldTemplate: CustomFieldTemplate }}
                  >
                    {/* Hide default submit button */}
                    <></>
                  </Form>
                )
              ) : input.activeTab === "json" ? (
                <div className="flex flex-col flex-1 min-h-0 space-y-2">
                  <Textarea
                    value={input.jsonInput}
                    onChange={(e) => {
                      const v = e.target.value;
                      let err: string | null = null;
                      let parsed: Record<string, unknown> | undefined;
                      try { parsed = JSON.parse(v); } catch { err = "Invalid JSON"; }
                      setInput((prev) => ({
                        ...prev,
                        jsonInput: v,
                        jsonError: err,
                        ...(parsed !== undefined ? { formData: parsed } : {}),
                      }));
                    }}
                    className="flex-1 resize-none font-mono text-xs"
                    placeholder='{ "key": "value" }'
                  />
                  {input.jsonError && <p className="text-xs text-destructive shrink-0">{input.jsonError}</p>}
                </div>
              ) : (
                <JsonView data={schema} defaultExpandDepth={4} />
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right: Result */}
        <div className="flex flex-[4] flex-col min-w-0">
          <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
            {/* Left: Save as case */}
            <div className="flex items-center">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1.5 rounded-sm px-2.5 text-xs"
                onClick={() => setSaveDialogOpen(true)}
                disabled={
                  exec.executing ||
                  (displayTask
                    ? displayTask.status !== "completed"
                    : exec.result === null) ||
                  displayError !== null ||
                  exec.executedArgs === null ||
                  activeToolName === null
                }
                title="Save this call as a verification case"
              >
                <Save className="h-3.5 w-3.5" />
                Save as case
              </Button>
            </div>

            {/* Center: Tabs */}
            <div className="flex-1 flex justify-center items-stretch">
              <button
                type="button"
                onClick={() => setResultTab("view")}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                  resultTab === "view"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                Result View
              </button>
              <button
                type="button"
                onClick={() => setResultTab("raw")}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                  resultTab === "raw"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                Raw Json
              </button>
            </div>

            {/* Right: Copy */}
            <div className="flex items-center gap-2">
              {(durationStr || resultSizeStr) && (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {[durationStr, resultSizeStr].filter(Boolean).join(" | ")}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 rounded-sm"
                onClick={async () => {
                  const target = resultTab === "raw" ? displayRawJson : (displayResult ?? displayTask);
                  if (!target) return;
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(target, null, 2));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch { /* clipboard unavailable */ }
                }}
                disabled={
                  resultTab === "raw"
                    ? !displayRawJson
                    : (!displayResult && !displayTask) || (displayTask !== null && displayTask.status === "working")
                }
                title="Copy JSON"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3">
              {displayError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-xs text-destructive">{displayError}</p>
                </div>
              ) : displayTask ? (
                <>
                  <TaskBannerCard
                    task={displayTask}
                    snapshotSeq={selectedSnapshotSeq}
                    onSelectTask={(tid) => {
                      setSelectedTaskId(tid);
                      const found = tasks.find((t) => t.taskId === tid) ?? (selectedTask?.taskId === tid ? selectedTask : null);
                      if (found) setSelectedTask(found);
                      setSelectedSnapshotSeq(null);
                      setActiveTab("tasks");
                    }}
                  />
                  {displayTask.status === "completed" ? (
                    <>
                      <div className={cn(resultTab !== "view" && "hidden")}>
                        {displayResult !== null && displayResult !== undefined ? (
                          typeof displayResult === "object" ? (
                            <JsonView data={displayResult as Record<string, unknown>} defaultExpandDepth={3} />
                          ) : (
                            <pre className="font-mono text-xs text-foreground bg-muted/30 p-2 rounded-md whitespace-pre-wrap break-all">
                              {String(displayResult)}
                            </pre>
                          )
                        ) : (
                          <p className="text-xs text-muted-foreground">No result data.</p>
                        )}
                      </div>
                      <div className={cn(resultTab !== "raw" && "hidden")}>
                        <pre className="font-mono text-xs text-foreground bg-muted/30 p-2 rounded-md whitespace-pre-wrap break-all">
                          {JSON.stringify(displayRawJson, null, 2)}
                        </pre>
                      </div>
                    </>
                  ) : displayTask.status === "working" || displayTask.status === "input_required" ? (
                    <>
                      <div className={cn(resultTab !== "view" && "hidden")}>
                        {Object.keys(displayTask.raw).length > 0 ? (
                          <JsonView data={displayTask.raw} defaultExpandDepth={2} />
                        ) : (
                          <p className="text-xs text-muted-foreground">Task is currently {TASK_STATUS_LABELS[displayTask.status].toLowerCase()}…</p>
                        )}
                      </div>
                      <div className={cn(resultTab !== "raw" && "hidden")}>
                        <pre className="font-mono text-xs text-foreground bg-muted/30 p-2 rounded-md whitespace-pre-wrap break-all">
                          {JSON.stringify(displayRawJson, null, 2)}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                      <p className="text-xs text-destructive">
                        {((displayTask.raw as Record<string, unknown>)?.error as Record<string, unknown>)?.message as string ??
                          displayTask.statusMessage ??
                          "The task did not complete successfully."}
                      </p>
                    </div>
                  )}
                </>
              ) : exec.result !== null ? (
                <>
                  <div className={cn(resultTab !== "view" && "hidden")}>
                    <JsonView data={exec.result as Record<string, unknown>} defaultExpandDepth={3} />
                  </div>
                  <div className={cn(resultTab !== "raw" && "hidden")}>
                    <pre className="font-mono text-xs text-foreground bg-muted/30 p-2 rounded-md whitespace-pre-wrap break-all">
                      {JSON.stringify(exec.result, null, 2)}
                    </pre>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Click Run to execute the tool.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {activeToolName !== null && exec.executedArgs !== null && (
        <SaveAsCaseDialog
          open={saveDialogOpen}
          onOpenChange={setSaveDialogOpen}
          mcpServerId={serverId}
          serverName={serverName}
          toolName={activeToolName}
          input={exec.executedArgs}
        />
      )}
    </div>
  );
}
