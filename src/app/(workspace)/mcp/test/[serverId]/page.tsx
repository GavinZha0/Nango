"use client";

/**
 * MCP Tool Test Page
 */

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, Play, Loader2, Search, Save, ChevronDown, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { JsonView } from "@/components/ui/json-view";
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
  type ToolInputSnapshot,
} from "@/lib/mcp/snapshots";

import { withTheme } from "@rjsf/core";
import { Theme as ShadcnTheme } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import type { FieldTemplateProps } from "@rjsf/utils";
import type { McpToolSnapshot } from "@/lib/db/schema";

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

/** Consolidated execution lifecycle state — reset together on tool switch and before each run. */
interface ExecState {
  executing: boolean;
  result: unknown | null;
  execError: string | null;
  executedArgs: Record<string, unknown> | null;
}

const IDLE_EXEC: ExecState = {
  executing: false,
  result: null,
  execError: null,
  executedArgs: null,
};

// History dropdown — auto-saved on each successful execution

interface HistoryDropdownProps {
  serverId: string;
  toolName: string | null;
  onLoad: (args: Record<string, unknown>) => void;
}

function HistoryDropdown({ serverId, toolName, onLoad }: HistoryDropdownProps): ReactNode {
  const [snapshots, setSnapshots] = useState<ToolInputSnapshot[]>(
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

  if (!toolName) return null;

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) refresh(); }}>
      <DropdownMenuTrigger
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        History
        {snapshots.length > 0 && (
          <span className="text-[10px] tabular-nums opacity-70">({snapshots.length})</span>
        )}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {snapshots.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            No history yet. Run the tool to record.
          </div>
        ) : (
          snapshots.map((snap) => (
            <DropdownMenuItem
              key={snap.id}
              onClick={() => onLoad(snap.args)}
              className="group flex items-center gap-1.5"
            >
              <span className={cn("flex-1 truncate text-xs", snap.pinned && "font-medium")}>{snap.name}</span>
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
          ))
        )}
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
  const [serverName, setServerName] = useState("");
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [toolSearch, setToolSearch] = useState<string>("");

  // Selection is component-local (not in the URL) — fresh mount /
  // refresh always lands on the first tool. Keeps the URL shape
  // simple at `/mcp/test/<serverId>`.
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);

  const [input, setInput] = useState<InputState>(EMPTY_INPUT);
  const [exec, setExec] = useState<ExecState>(IDLE_EXEC);
  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);

  /** Per-tool state cache so switching tools preserves input + result. */
  const toolStateCache = useRef<Map<string, { input: InputState; exec: ExecState }>>(new Map());

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
      } catch { /* silent */ }
      if (!cancelled) setLoadingMeta(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [serverId]);

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
    const q: string = toolSearch.trim().toLowerCase();
    if (q.length === 0) return serverTools;
    return serverTools.filter((t) => {
      if (t.name.toLowerCase().includes(q)) return true;
      const desc: string = t.description ?? "";
      return desc.toLowerCase().includes(q);
    });
  }, [serverTools, toolSearch]);

  // Execute tool
  const activeToolName: string | null = tool?.name ?? null;
  const handleExecute = useCallback(async () => {
    if (activeToolName === null) return;
    setExec({ executing: true, result: null, execError: null, executedArgs: null });

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

    try {
      const res = await fetch(`/api/mcp-servers/${serverId}/call-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: activeToolName, args }),
      });
      const data = await res.json();
      if (!res.ok) {
        setExec({ executing: false, result: null, execError: data.error ?? "Execution failed", executedArgs: null });
      } else {
        setExec({ executing: false, result: data.result, execError: null, executedArgs: args });
        // Auto-save input args to history on successful execution.
        // Skip no-param tools — nothing useful to reload.
        if (Object.keys(args).length > 0) {
          saveSnapshot(serverId, activeToolName, formatTimestamp(new Date(), tz, "datetimePrecise"), args);
        }
      }
    } catch (err) {
      setExec({ executing: false, result: null, execError: err instanceof Error ? err.message : "Unexpected error", executedArgs: null });
    }
  }, [input.activeTab, input.jsonInput, input.formData, serverId, activeToolName, tz]);

  const schema = (tool?.input_schema as Record<string, unknown>) ?? {};
  const uiSchema = generateUiSchema(schema);

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
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => router.push("/mcp")} aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-sm font-semibold shrink-0 truncate max-w-[40%]">
          {tool?.name ?? (serverName || "Select a tool")}
        </h2>
        {tool !== null && (tool.description ?? serverName) && (
          <span className="text-xs text-muted-foreground truncate min-w-0">
            — {tool.description ?? serverName}
          </span>
        )}
      </div>

      {/* Three-column content (tool list + input + result). */}
      <div className="flex flex-1 min-h-0">
        {/* Tool list — search box on top + scrollable list. */}
        <div className="flex flex-[3] flex-col border-r min-w-0">
          <div className="border-b bg-muted/40 px-2 py-1.5">
            <div className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                type="text"
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
                placeholder="Search tools…"
                aria-label="Search tools"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
              />
              {toolSearch.length > 0 && (
                <button
                  type="button"
                  onClick={() => setToolSearch("")}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            {serverTools.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                No tools discovered yet. Refresh the server in the left panel to scan.
              </div>
            ) : filteredTools.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                No tools match &ldquo;{toolSearch}&rdquo;.
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
                        className={cn(
                          "block w-full border-b border-border/40 px-3 py-2 text-left transition-colors",
                          active
                            ? "bg-accent"
                            : "hover:bg-muted/50",
                        )}
                      >
                        <div
                          className={cn(
                            "truncate font-mono text-sm font-medium",
                            active ? "text-accent-foreground" : "text-foreground/90",
                          )}
                        >
                          {t.name}
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
            <div className="ml-auto flex items-center gap-1">
              <HistoryDropdown
                serverId={serverId}
                toolName={activeToolName}
                onLoad={(args) => setInput((prev) => ({ ...prev, formData: args, jsonInput: JSON.stringify(args, null, 2) }))}
              />
              <Button
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={handleExecute}
                disabled={exec.executing || executeDisabled}
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
            <div className="p-3">
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
                <div className="space-y-2">
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
                    className="min-h-[200px] font-mono text-xs"
                    placeholder='{ "key": "value" }'
                  />
                  {input.jsonError && <p className="text-xs text-destructive">{input.jsonError}</p>}
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
            {/* Save-as-case lives here (Result column header) rather than
                next to Execute, so the visual order matches the workflow:
                run on the left, then capture on the right. Enabled only
                after a SUCCESSFUL run — see `executedArgs`. */}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 rounded-none px-2.5 text-xs"
              onClick={() => setSaveDialogOpen(true)}
              disabled={
                exec.executing ||
                exec.result === null ||
                exec.execError !== null ||
                exec.executedArgs === null ||
                activeToolName === null
              }
              title="Save this call as a verification case"
            >
              <Save className="h-3.5 w-3.5" />
              Save as case
            </Button>
            <span className="ml-auto self-center py-1.5 border-b-2 border-transparent text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Result
            </span>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3">
              {exec.execError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-xs text-destructive">{exec.execError}</p>
                </div>
              ) : exec.result !== null ? (
                <JsonView data={exec.result} defaultExpandDepth={3} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Click Execute to run the tool.
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
