/**
 * Inspector Body specifically for Tool nodes.
 * Supports dynamic Tool Source, Tool Name dropdowns, RJSF Form vs JSON mode, and schema extraction.
 */

import {
  type ReactElement,
  useState,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import RjsfForm from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type { RJSFSchema } from "@rjsf/utils";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CanonicalToolNode } from "@/lib/workflows";
import { Section } from "./InspectorDrawer";
import { buildToolNodeInputSchema } from "./utils";
import { validateToolSource } from "@/lib/workflows/spec/schema";

interface McpToolSnapshot {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  enabled?: boolean;
}

interface McpServerInfo {
  id: string;
  name: string;
  description?: string;
  serverVersion?: string;
  tools?: McpToolSnapshot[] | null;
}

interface BuiltinToolDescriptorInfo {
  name: string;
  displayName: string;
  description: string;
  category?: string;
  input_schema?: Record<string, unknown>;
}

export function ToolBody({
  node,
  onChange,
}: {
  node: CanonicalToolNode;
  onChange: (updated: CanonicalToolNode) => void;
}): ReactElement {
  const [builtinTools, setBuiltinTools] = useState<BuiltinToolDescriptorInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [editorMode, setEditorMode] = useState<"form" | "json">("form");

  useEffect(() => {
    let cancelled = false;
    async function loadToolsMeta() {
      try {
        const res = await fetch("/api/tools");
        if (!res.ok) return;
        const data = (await res.json()) as {
          builtinTools?: BuiltinToolDescriptorInfo[];
          mcpServers?: McpServerInfo[];
        };
        if (!cancelled) {
          if (Array.isArray(data.builtinTools)) setBuiltinTools(data.builtinTools);
          if (Array.isArray(data.mcpServers)) setMcpServers(data.mcpServers);
        }
      } catch {
        // Fallback
      }
    }
    void loadToolsMeta();
    return () => {
      cancelled = true;
    };
  }, []);

  const rawToolName = node.inputs.name ?? "";

  // Infer the selected tool source (builtin vs mcp:<id>)
  const inferredSourceId = useMemo(() => {
    if (node.inputs.source && node.inputs.source !== "custom") {
      // Validate existing source format
      if (validateToolSource(node.inputs.source)) {
        return node.inputs.source;
      }
      // If invalid, fall through to inference
      console.warn(`[ToolBody] Invalid existing source: ${node.inputs.source}, re-inferring`);
    }
    const matchedServer = mcpServers.find(
      (s) =>
        rawToolName.startsWith(`mcp__${s.name}__`) ||
        rawToolName.startsWith(`${s.name}_`) ||
        (s.tools && s.tools.some((t) => t.name === rawToolName)),
    );
    if (matchedServer) {
      const inferredSource = `mcp:${matchedServer.id}`;
      // Validate the inferred source format
      if (validateToolSource(inferredSource)) {
        return inferredSource;
      }
    }
    return "builtin";
  }, [node.inputs.source, rawToolName, mcpServers]);

  const [prevInferredSourceId, setPrevInferredSourceId] = useState(inferredSourceId);
  const [selectedSource, setSelectedSource] = useState<string>(inferredSourceId);

  if (prevInferredSourceId !== inferredSourceId) {
    setPrevInferredSourceId(inferredSourceId);
    setSelectedSource(inferredSourceId);
  }

  // Ensure node.inputs.source is always populated on the draft node
  useEffect(() => {
    if (!node.inputs.source) {
      onChange({
        ...node,
        inputs: {
          ...node.inputs,
          source: inferredSourceId,
        },
      });
    }
  }, [node, inferredSourceId, onChange]);

  // Validate source format to match backend validation
  useEffect(() => {
    if (node.inputs.source && !validateToolSource(node.inputs.source)) {
      // If current source is invalid, reset to a valid default
      console.warn(`[ToolBody] Invalid source format: ${node.inputs.source}, resetting to builtin`);
      onChange({
        ...node,
        inputs: {
          ...node.inputs,
          source: "builtin",
        },
      });
    }
  }, [node, node.inputs.source, onChange]);

  // Derived available tools for selected source
  const availableToolsForSource = useMemo<
    Array<{
      name: string;
      label: string;
      description: string;
      input_schema?: Record<string, unknown>;
      server_version?: string;
    }>
  >(() => {
    if (selectedSource === "builtin") {
      return builtinTools.map((t) => ({
        name: t.name,
        label: t.displayName || t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }
    if (selectedSource.startsWith("mcp:")) {
      const serverId = selectedSource.replace("mcp:", "");
      const server = mcpServers.find((s) => s.id === serverId);
      if (server) {
        if (Array.isArray(server.tools) && server.tools.length > 0) {
          return server.tools.map((t) => ({
            name: `mcp__${server.name}__${t.name}`,
            label: t.name,
            description: t.description || `Tool provided by MCP Server ${server.name}`,
            input_schema: t.input_schema,
            server_version: server.serverVersion,
          }));
        }
        return [
          {
            name: `mcp__${server.name}`,
            label: `mcp__${server.name}`,
            description: server.description || `MCP Server ${server.name}`,
            server_version: server.serverVersion,
          },
        ];
      }
    }
    return [];
  }, [selectedSource, builtinTools, mcpServers]);

  const [prevArguments, setPrevArguments] = useState(node.inputs.arguments);
  const [argumentsJsonText, setArgumentsJsonText] = useState(() =>
    JSON.stringify(node.inputs.arguments ?? {}, null, 2),
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  if (prevArguments !== node.inputs.arguments) {
    setPrevArguments(node.inputs.arguments);
    setArgumentsJsonText(JSON.stringify(node.inputs.arguments ?? {}, null, 2));
    setJsonError(null);
  }

  const handleJsonChange = (text: string) => {
    setArgumentsJsonText(text);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setJsonError(null);
      onChange({
        ...node,
        inputs: {
          ...node.inputs,
          arguments: parsed,
        },
      });
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  const handleFormatJson = useCallback(() => {
    try {
      const parsed = JSON.parse(argumentsJsonText) as Record<string, unknown>;
      const formatted = JSON.stringify(parsed, null, 2);
      setArgumentsJsonText(formatted);
      setJsonError(null);
      onChange({
        ...node,
        inputs: {
          ...node.inputs,
          arguments: parsed,
        },
      });
      toast.success("JSON formatted");
    } catch {
      toast.error("Prettify JSON failed: invalid JSON syntax");
    }
  }, [argumentsJsonText, node, onChange]);

  // Extract RJSF Arguments Schema if available (supports standard wrapper or raw schema)
  const argumentsRjsfSchema = useMemo<RJSFSchema | null>(() => {
    const schema = node.input_schema as Record<string, unknown> | undefined;
    if (!schema) return null;
    const props = schema.properties as Record<string, unknown> | undefined;
    if (props && props.arguments && typeof props.arguments === "object") {
      return props.arguments as RJSFSchema;
    }
    if (schema.type === "object" || schema.properties) {
      return schema as RJSFSchema;
    }
    return null;
  }, [node.input_schema]);

  return (
    <>
      {/* Level 1: Tool Source Select */}
      <Section title="Tool Source">
        <select
          className="h-7 w-full rounded border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={selectedSource}
          onChange={(e) => {
            const newSource = e.target.value;
            // Validate source format before applying change
            if (!validateToolSource(newSource)) {
              toast.error(`Invalid source format: ${newSource}. Must be 'builtin', 'custom', or 'mcp:<server_id>'`);
              return;
            }
            setSelectedSource(newSource);
            if (newSource === "builtin") {
              const defaultBuiltin = builtinTools[0];
              if (defaultBuiltin) {
                const updatedInputSchema = buildToolNodeInputSchema(
                  defaultBuiltin.name,
                  defaultBuiltin.input_schema,
                );
                onChange({
                  ...node,
                  description: defaultBuiltin.description || node.description || "",
                  inputs: {
                    ...node.inputs,
                    source: "builtin",
                    name: defaultBuiltin.name,
                  },
                  input_schema: updatedInputSchema,
                });
              } else {
                onChange({
                  ...node,
                  inputs: {
                    ...node.inputs,
                    source: "builtin",
                  },
                });
              }
            } else if (newSource.startsWith("mcp:")) {
              const serverId = newSource.replace("mcp:", "");
              // Additional validation for MCP server ID format
              const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
              if (!uuidRegex.test(serverId)) {
                toast.error(`Invalid MCP server ID format: ${serverId}. Must be a valid UUID.`);
                return;
              }
              const server = mcpServers.find((s) => s.id === serverId);
              if (server) {
                const firstTool = server.tools?.[0];
                const toolName = firstTool
                  ? `mcp__${server.name}__${firstTool.name}`
                  : `mcp__${server.name}`;
                const toolDesc =
                  firstTool?.description ||
                  server.description ||
                  `Tool provided by MCP Server ${server.name}`;
                const updatedInputSchema = buildToolNodeInputSchema(
                  toolName,
                  firstTool?.input_schema,
                  server.serverVersion,
                );
                onChange({
                  ...node,
                  description: toolDesc || node.description || "",
                  inputs: {
                    ...node.inputs,
                    source: newSource,
                    name: toolName,
                  },
                  input_schema: updatedInputSchema,
                });
              }
            }
          }}
        >
          <option value="builtin">Builtin Tools</option>
          {mcpServers
            .filter((s) => Array.isArray(s.tools) && s.tools.length > 0)
            .map((s) => (
              <option key={s.id} value={`mcp:${s.id}`}>
                MCP Server: {s.name} ({s.tools?.length ?? 0})
              </option>
            ))}
        </select>
      </Section>

      {/* Level 2: Tool Name Select */}
      <Section title="Tool Name">
        <select
          className="h-7 w-full rounded border border-input bg-background px-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={rawToolName}
          onChange={(e) => {
            const selectedToolName = e.target.value;
            const matched = availableToolsForSource.find(
              (t) => t.name === selectedToolName,
            );
            const updatedInputSchema = buildToolNodeInputSchema(
              selectedToolName,
              matched?.input_schema,
              matched?.server_version,
            );
            onChange({
              ...node,
              description: matched?.description || node.description || "",
              inputs: {
                ...node.inputs,
                source: selectedSource,
                name: selectedToolName,
              },
              input_schema: updatedInputSchema,
            });
          }}
        >
          {availableToolsForSource.map((t) => (
            <option key={t.name} value={t.name}>
              {t.label}
            </option>
          ))}
          {!availableToolsForSource.some((t) => t.name === rawToolName) && rawToolName && (
            <option value={rawToolName}>{rawToolName}</option>
          )}
        </select>
      </Section>

      {/* Tool Arguments View Switcher (Form vs JSON) */}
      <Section title="Tool Arguments" className="flex-1 min-h-0 flex flex-col">
        <div className="flex flex-1 min-h-0 flex-col gap-2">
          <div className="flex shrink-0 items-center justify-between">
            <div className="flex items-center gap-1 rounded bg-muted/40 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setEditorMode("form")}
                disabled={!argumentsRjsfSchema}
                className={cn(
                  "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                  editorMode === "form"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                  !argumentsRjsfSchema && "opacity-50 cursor-not-allowed",
                )}
                title={
                  !argumentsRjsfSchema
                    ? "No input_schema defined for arguments form"
                    : "Form editor mode"
                }
              >
                Form
              </button>
              <button
                type="button"
                onClick={() => setEditorMode("json")}
                className={cn(
                  "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                  editorMode === "json"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="JSON code editor mode"
              >
                JSON
              </button>
            </div>

            {editorMode === "json" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground gap-1"
                onClick={handleFormatJson}
                title="Prettify JSON arguments"
              >
                <Sparkles className="h-3 w-3" />
                Prettify JSON
              </Button>
            )}
          </div>

          {editorMode === "form" && argumentsRjsfSchema ? (
            <div
              className={cn(
                "flex-1 min-h-0 rounded border border-input bg-background/50 p-3 text-xs max-h-[30lh] overflow-y-auto",
                "[&_.form-group]:mb-3",
                "[&_label]:block [&_label]:mb-1 [&_label]:text-[11px] [&_label]:font-medium [&_label]:text-foreground",
                "[&_input]:h-7 [&_input]:w-full [&_input]:rounded [&_input]:border [&_input]:border-input [&_input]:bg-background [&_input]:px-2 [&_input]:text-xs [&_input]:text-foreground [&_input]:shadow-sm [&_input]:focus:outline-none [&_input]:focus:ring-1 [&_input]:focus:ring-ring",
                "[&_select]:h-7 [&_select]:w-full [&_select]:rounded [&_select]:border [&_select]:border-input [&_select]:bg-background [&_select]:px-2 [&_select]:text-xs [&_select]:text-foreground [&_select]:shadow-sm [&_select]:focus:outline-none [&_select]:focus:ring-1 [&_select]:focus:ring-ring",
                "[&_textarea]:w-full [&_textarea]:rounded [&_textarea]:border [&_textarea]:border-input [&_textarea]:bg-background [&_textarea]:p-2 [&_textarea]:font-mono [&_textarea]:text-xs [&_textarea]:text-foreground [&_textarea]:shadow-sm [&_textarea]:focus:outline-none [&_textarea]:focus:ring-1 [&_textarea]:focus:ring-ring",
                "[&_.checkbox_label]:flex [&_.checkbox_label]:items-center [&_.checkbox_label]:gap-2 [&_.checkbox_label]:text-xs [&_.checkbox_label]:text-foreground",
                "[&_.checkbox_input]:h-4 [&_.checkbox_input]:w-4 [&_.checkbox_input]:rounded [&_.checkbox_input]:border-input",
                "[&_.field-description]:text-[10px] [&_.field-description]:text-muted-foreground [&_.field-description]:mt-0.5",
                "[&_.error-detail]:text-[10px] [&_.error-detail]:text-destructive [&_.error-detail]:mt-0.5",
              )}
            >
              <RjsfForm
                schema={argumentsRjsfSchema}
                validator={validator}
                formData={node.inputs.arguments ?? {}}
                onChange={(e) => {
                  if (e.formData && typeof e.formData === "object") {
                    onChange({
                      ...node,
                      inputs: {
                        ...node.inputs,
                        arguments: e.formData as Record<string, unknown>,
                      },
                    });
                  }
                }}
                uiSchema={{
                  "ui:submitButtonOptions": { norender: true },
                }}
              />
            </div>
          ) : (
            <div className="flex flex-1 min-h-0 flex-col gap-1">
              {jsonError && (
                <span className="text-[10px] text-destructive truncate">
                  {jsonError}
                </span>
              )}
              <textarea
                className={cn(
                  "flex-1 min-h-0 w-full rounded border bg-background p-2 font-mono text-[11px] leading-snug text-foreground resize-none max-h-[30lh] overflow-y-auto focus:outline-none focus:ring-1 focus:ring-ring",
                  jsonError ? "border-destructive/60 focus:ring-destructive" : "border-input",
                )}
                rows={30}
                value={argumentsJsonText}
                onChange={(e) => handleJsonChange(e.target.value)}
              />
            </div>
          )}
        </div>
      </Section>
    </>
  );
}
