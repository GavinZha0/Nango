"use client";

/**
 * MCP Tool Test Page
 */

import { useState, useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, Play, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { JsonView } from "@/components/ui/json-view";
import { cn } from "@/lib/utils";

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
    // Label / description sizes:
    //   - label:       text-sm (14 px) — primary control identifier
    //   - description: text-xs (12 px) — secondary hint, muted colour
    // Both use Tailwind preset sizes so the line-height comes from the
    // preset (20 px and 16 px respectively) rather than being inherited
    // from the body — previously `text-[11px]` had no matching line-
    // height token so it would inherit whatever the parent set,
    // accidentally rendering looser than the 12 px font-medium label
    // above it and giving the (false) impression that the description
    // was actually larger than the label.
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

/**
 * Page outer — reads the `serverId` route param and hands it to
 * `<ServerView>` via `key={serverId}`. The `key` is what gives us
 * automatic state reset when the user navigates to a different
 * server: React unmounts `<ServerView>` and re-mounts a fresh one,
 * so every useState inside re-initialises. No sentinel patterns,
 * no manual prop-change handling.
 */
export default function McpToolTestPage(): ReactNode {
  const { serverId } = useParams<{ serverId: string }>();
  return <ServerView key={serverId} serverId={serverId} />;
}

function ServerView({ serverId }: { serverId: string }): ReactNode {
  const router = useRouter();

  // Tool metadata
  const [serverTools, setServerTools] = useState<McpToolSnapshot[]>([]);
  const [serverName, setServerName] = useState("");
  const [loadingMeta, setLoadingMeta] = useState(true);

  // Tool list search — filters `serverTools` shown in the left column.
  const [toolSearch, setToolSearch] = useState<string>("");

  // Selected tool — component state, NOT URL. When `null`, the picker
  // (derived `tool` below) falls back to the first tool in
  // `serverTools`. So a fresh mount / page refresh always lands on
  // the first tool; the user can pick a different one but it does
  // not survive a refresh — a deliberate choice for keeping the URL
  // shape simple (`/mcp/test/<serverId>`).
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);

  // Input
  const [activeTab, setActiveTab] = useState<InputTab>("form");
  const [jsonInput, setJsonInput] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  // Execution
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<unknown | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  // Load server + tools list once. `serverId` is fixed for this
  // `<ServerView>` instance (the outer `Page` keys on it), so this
  // useEffect only fires on the initial mount of any given server's
  // view — no refetch when the user clicks between tools.
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

  // Active tool is derived: picked one if any, otherwise the first
  // tool in the list (or null when no tools).
  const tool: McpToolSnapshot | null = useMemo(() => {
    if (selectedToolName !== null) {
      const picked = serverTools.find((t) => t.name === selectedToolName);
      if (picked) return picked;
    }
    return serverTools[0] ?? null;
  }, [serverTools, selectedToolName]);

  // Search-filtered tools list shown in the left column. Plain
  // substring match on name + description; case-insensitive.
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
    setExecuting(true);
    setExecError(null);
    setResult(null);

    let args: Record<string, unknown>;
    if (activeTab === "json") {
      try {
        args = JSON.parse(jsonInput);
      } catch {
        setJsonError("Invalid JSON");
        setExecuting(false);
        return;
      }
    } else {
      args = formData;
    }

    try {
      const res = await fetch(`/api/mcp-servers/${serverId}/call-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: activeToolName, args }),
      });
      const data = await res.json();
      if (!res.ok) {
        setExecError(data.error ?? "Execution failed");
      } else {
        setResult(data.result);
      }
    } catch (err) {
      setExecError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setExecuting(false);
    }
  }, [activeTab, jsonInput, formData, serverId, activeToolName]);

  const schema = (tool?.input_schema as Record<string, unknown>) ?? {};
  const uiSchema = generateUiSchema(schema);

  /**
   * Pick a tool: reset all per-tool input/output state so leftovers
   * from the previous tool don't pollute the new selection. No URL
   * navigation — selection is component-local state.
   */
  function handleSelectTool(name: string): void {
    if (name === activeToolName) return;
    setSelectedToolName(name);
    setFormData({});
    setJsonInput("{}");
    setJsonError(null);
    setResult(null);
    setExecError(null);
    setActiveTab("form");
  }

  // Disable Execute when the current input mode can't produce valid args.
  // For the JSON tab that means a parse error; the Form tab is validated by
  // RJSF inline and we just block the click here while executing. Also
  // disabled when no tool is resolved (server has no tools, or the URL
  // toolName doesn't match anything in the cached list).
  const executeDisabled: boolean =
    tool === null || (activeTab === "json" && jsonError !== null);

  // Platform-aware Cmd/Ctrl + Enter shortcut. We resolve it via
  // useSyncExternalStore so SSR / hydration sees a stable "Ctrl" label and
  // the client swaps in "⌘" only after mount (no hydration mismatch).
  const isMac: boolean = useSyncExternalStore(
    () => () => {},
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => false,
  );
  const executeShortcutHint: string = useMemo(
    () => (isMac ? "⌘↵" : "Ctrl+↵"),
    [isMac],
  );
  const executeShortcutLabel: string = useMemo(
    () => `Run tool (${isMac ? "⌘" : "Ctrl"} + Enter)`,
    [isMac],
  );

  // Global Cmd/Ctrl + Enter shortcut. Listens on window so the keystroke
  // fires from anywhere on the page — including while focused inside the
  // RJSF form or the JSON textarea.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Enter") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (executing || executeDisabled) return;
      e.preventDefault();
      void handleExecute();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleExecute, executing, executeDisabled]);

  if (loadingMeta) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header — single row: back arrow + tool name + description.
          Matches the left panel's "MCP Servers" h2 size (text-sm font-semibold)
          so the page header and the panel header sit at the same visual level. */}
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

      {/* Three-column content (tool list + input + result).
          Columns share width at 3:3:4 — tool list and input get equal
          room (~30 % each), result gets the remaining ~40 % since it
          tends to render the longest JSON trees. The tool list moved
          here from the McpPanel sidebar so it can be search-filtered
          and given more room than a nested sidebar list. */}
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
          {/* Tabs row — input-mode tabs on the left, Execute on the right.
              Co-locating Execute with the input column keeps the trigger
              within easy reach of the parameter editor (Fitts' Law). */}
          <div className="flex items-stretch border-b bg-muted/40 pr-1.5">
            <button
              type="button"
              onClick={() => setActiveTab("form")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                activeTab === "form"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              Form
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("json")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                activeTab === "json"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              JSON
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("schema")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                activeTab === "schema"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              Schema
            </button>
            <div className="ml-auto flex items-center">
              <Button
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={handleExecute}
                disabled={executing || executeDisabled}
                title={executeShortcutLabel}
              >
                {executing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-green-500 text-green-500" />
                )}
                Execute
                <kbd className="ml-1 hidden text-[10px] opacity-70 sm:inline">{executeShortcutHint}</kbd>
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
              ) : activeTab === "form" ? (
                Object.keys(schema).length === 0 ? (
                  <p className="text-xs text-muted-foreground">This tool takes no input parameters.</p>
                ) : (
                  <Form
                    schema={schema}
                    uiSchema={uiSchema}
                    validator={validator}
                    formData={formData}
                    onChange={(e) => {
                      setFormData(e.formData ?? {});
                      setJsonInput(JSON.stringify(e.formData ?? {}, null, 2));
                    }}
                    templates={{ FieldTemplate: CustomFieldTemplate }}
                  >
                    {/* Hide default submit button */}
                    <></>
                  </Form>
                )
              ) : activeTab === "json" ? (
                <div className="space-y-2">
                  <Textarea
                    value={jsonInput}
                    onChange={(e) => {
                      setJsonInput(e.target.value);
                      setJsonError(null);
                      try { JSON.parse(e.target.value); } catch { setJsonError("Invalid JSON"); }
                    }}
                    className="min-h-[200px] font-mono text-xs"
                    placeholder='{ "key": "value" }'
                  />
                  {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
                </div>
              ) : (
                <JsonView data={schema} defaultExpandDepth={4} />
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right: Result */}
        <div className="flex flex-[4] flex-col min-w-0">
          <div className="flex items-center justify-center border-b bg-muted/40 px-3">
            <span className="py-1.5 border-b-2 border-transparent text-xs font-medium text-muted-foreground uppercase tracking-wide">Result</span>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3">
              {execError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-xs text-destructive">{execError}</p>
                </div>
              ) : result !== null ? (
                <JsonView data={result} defaultExpandDepth={3} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Click Execute to run the tool.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
