/**
 * InspectorDrawer — per-node detail pane shown to the right of the
 * workflow graph canvas when a node is selected.
 */

import {
  type ReactElement,
  type ReactNode,
  useState,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import {
  X,
  Save,
  Copy,
  Loader2,
  Wrench,
  Bot,
  Code2,
  Database,
  BarChart3,
  CircleDot,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { JsonView } from "@/components/ui/json-view";
import { cn } from "@/lib/utils";

import type {
  CanonicalNode,
  CanonicalToolNode,
  CanonicalAgentNode,
} from "@/lib/workflows";

type NodeType = CanonicalNode["type"];

import { ToolBody } from "./ToolBody";
import { AgentBody, CodeBody, SqlBody, ChartBody } from "./SpecializedBodies";

export interface InspectorDrawerProps {
  node: CanonicalNode;
  onClose: () => void;
  onSaveNode?: (updated: CanonicalNode) => Promise<void> | void;
}

const TYPE_ACCENTS: Record<
  NodeType,
  {
    label: string;
    icon: typeof Wrench;
    iconBg: string;
    iconFg: string;
  }
> = {
  tool: {
    label: "Tool Node",
    icon: Wrench,
    iconBg: "bg-blue-500/15 dark:bg-blue-500/20",
    iconFg: "text-blue-600 dark:text-blue-400",
  },
  agent: {
    label: "Agent Node",
    icon: Bot,
    iconBg: "bg-purple-500/15 dark:bg-purple-500/20",
    iconFg: "text-purple-600 dark:text-purple-400",
  },
  code: {
    label: "Code Node",
    icon: Code2,
    iconBg: "bg-amber-500/15 dark:bg-amber-500/20",
    iconFg: "text-amber-600 dark:text-amber-400",
  },
  sql: {
    label: "SQL Node",
    icon: Database,
    iconBg: "bg-emerald-500/15 dark:bg-emerald-500/20",
    iconFg: "text-emerald-600 dark:text-emerald-400",
  },
  chart: {
    label: "Chart Node",
    icon: BarChart3,
    iconBg: "bg-pink-500/15 dark:bg-pink-500/20",
    iconFg: "text-pink-600 dark:text-pink-400",
  },
};

export function InspectorDrawer({
  node,
  onClose,
  onSaveNode,
}: InspectorDrawerProps): ReactElement {
  const [prevNode, setPrevNode] = useState(node);
  const [draftNode, setDraftNode] = useState<CanonicalNode>(node);
  const [isSaving, setIsSaving] = useState(false);

  if (prevNode !== node) {
    setPrevNode(node);
    setDraftNode(node);
  }

  const isDirty = useMemo(() => {
    return JSON.stringify(draftNode) !== JSON.stringify(node);
  }, [draftNode, node]);

  const accent = TYPE_ACCENTS[draftNode.type] ?? {
    label: draftNode.type,
    icon: CircleDot,
    iconBg: "bg-muted",
    iconFg: "text-muted-foreground",
  };
  const Icon = accent.icon;

  const nodeId = draftNode.id;
  const title = useMemo(() => {
    switch (draftNode.type) {
      case "tool":
        return draftNode.inputs.name || "tool";
      case "agent":
        return draftNode.inputs.name || "agent";
      case "code":
        return draftNode.inputs.language || "code";
      case "sql":
        return draftNode.inputs.data_source_name || "sql";
      case "chart":
        return draftNode.inputs.renderer ?? "echarts";
      default:
        return String(nodeId);
    }
  }, [draftNode, nodeId]);

  const handleSave = useCallback(async () => {
    if (!onSaveNode) return;
    setIsSaving(true);
    try {
      await onSaveNode(draftNode);
      // toast.success(`Saved node ${draftNode.id}`);
    } catch (err) {
      toast.error(
        `Failed to save node: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      setIsSaving(false);
    }
  }, [draftNode, onSaveNode]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(draftNode, null, 2));
    toast.success(`Copied #${draftNode.id} canonical JSON to clipboard`);
  }, [draftNode]);

  // Esc key shortcut closes the inspector
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);



  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col bg-card">
      {/* Header — sticky-ish (parent ScrollArea is the body only) */}
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded",
            accent.iconBg,
          )}
        >
          <Icon className={cn("h-3 w-3", accent.iconFg)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">
            {title}
          </div>
          <div className="text-[10px] text-muted-foreground">
            #{draftNode.id} · {draftNode.type}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6 transition-colors",
            isDirty
              ? "text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
              : "text-muted-foreground/40 cursor-not-allowed",
          )}
          disabled={!isDirty || isSaving}
          onClick={() => void handleSave()}
          title={isDirty ? "Save" : "No change"}
          aria-label="Save node"
        >
          {isSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void handleCopy()}
          title="Copy"
          aria-label="Copy as JSON"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close inspector"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      {/* Body — flex-docked for Tool nodes, scrollable for others */}
      {draftNode.type === "tool" ? (
        <div className="flex flex-1 min-h-0 flex-col gap-3 p-3 text-xs overflow-hidden">
          <div className="shrink-0">
            <DescriptionSection
              node={draftNode}
              onChange={(description) =>
                setDraftNode((prev: CanonicalNode) => ({ ...prev, description }))
              }
            />
          </div>
          <ToolBody
            node={draftNode}
            onChange={(updated) => setDraftNode(updated)}
          />
          <div className="shrink-0 pt-1">
            <RuntimeMetaSection
              node={draftNode}
              onChange={(timeoutSeconds) =>
                setDraftNode((prev: CanonicalNode) => ({ ...prev, timeout_seconds: timeoutSeconds }))
              }
            />
          </div>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3 text-xs">
            {draftNode.type === "sql" && (
              <div className="flex flex-col gap-1 text-foreground">
                <KV label="tool" value="extract_dataset_by_sql" mono />
              </div>
            )}

            {draftNode.type === "code" && (
              <div className="flex flex-col gap-1 text-foreground">
                <KV label="tool" value="run_code_in_sandbox" mono />
              </div>
            )}

            {draftNode.type === "chart" && (
              <div className="flex flex-col gap-1 text-foreground">
                <KV label="tool" value="generate_echarts_config" mono />
              </div>
            )}

            <DescriptionSection
              node={draftNode}
              onChange={(description) =>
                setDraftNode((prev: CanonicalNode) => ({ ...prev, description }))
              }
            />
            {draftNode.type === "agent" && (
              <AgentBody
                node={draftNode}
                onChange={(updated) => setDraftNode(updated)}
              />
            )}
            {draftNode.type === "code" && (
              <CodeBody
                node={draftNode}
                onChange={(updated) => setDraftNode(updated)}
              />
            )}
            {draftNode.type === "sql" && (
              <SqlBody
                node={draftNode}
                onChange={(updated) => setDraftNode(updated)}
              />
            )}
            {draftNode.type === "chart" && (
              <ChartBody
                node={draftNode}
                onChange={(updated) => setDraftNode(updated)}
              />
            )}

            {/* Universal sections — these apply to every node type
                that has them. */}
            {hasInputMap(draftNode) && (
              <Section title="Input">
                <JsonView data={draftNode.inputs} defaultExpandDepth={2} />
              </Section>
            )}

            {hasOutputSchema(draftNode) && (
              <Section title="Output schema">
                <JsonView
                  data={draftNode.output_schema}
                  defaultExpandDepth={1}
                />
              </Section>
            )}

            {hasOutputs(draftNode) && (
              <Section title="Outputs">
                <ChipList items={draftNode.outputs} />
              </Section>
            )}

            <RuntimeMetaSection
              node={draftNode}
              onChange={(timeoutSeconds) =>
                setDraftNode((prev: CanonicalNode) => ({ ...prev, timeout_seconds: timeoutSeconds }))
              }
            />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

// ── Type-narrowing helpers ───────────────────────────────────────────

function hasInputMap(
  node: CanonicalNode,
): node is CanonicalToolNode | CanonicalAgentNode {
  return node.type === "tool" || node.type === "agent";
}

function hasOutputSchema(
  node: CanonicalNode,
): node is CanonicalNode & { output_schema: Record<string, unknown> } {
  return "output_schema" in node && (node as Record<string, unknown>).output_schema !== undefined;
}

function hasOutputs(
  node: CanonicalNode,
): node is CanonicalNode & { outputs: string[] } {
  const rec = node as Record<string, unknown>;
  return "outputs" in rec && Array.isArray(rec.outputs) && rec.outputs.length > 0;
}

// ── Small atoms & common sections ────────────────────────────────────

export interface SectionProps {
  title: string;
  children: ReactNode;
  className?: string;
  headerAction?: ReactNode;
}

export function Section({ title, children, className, headerAction }: SectionProps): ReactElement {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        {headerAction}
      </div>
      {children}
    </div>
  );
}

export function DescriptionSection({
  node,
  onChange,
}: {
  node: CanonicalNode;
  onChange: (description: string) => void;
}): ReactElement {
  return (
    <Section title="Description">
      <textarea
        className="w-full rounded border border-input bg-background p-1.5 text-xs text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        value={node.description ?? ""}
        placeholder="Node description"
        onChange={(e) => onChange(e.target.value)}
      />
    </Section>
  );
}

export function RuntimeMetaSection({
  node,
  onChange,
}: {
  node: CanonicalNode;
  onChange: (timeoutSeconds: number | undefined) => void;
}): ReactElement {
  return (
    <Section title="Timeout">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          className="h-7 w-28 text-xs font-mono"
          value={node.timeout_seconds ?? 30}
          onChange={(e) => {
            const raw = parseInt(e.target.value, 10);
            if (isNaN(raw)) {
              onChange(undefined);
            } else {
              onChange(Math.max(1, raw));
            }
          }}
        />
        <span className="text-xs text-muted-foreground">seconds</span>
      </div>
    </Section>
  );
}

export function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactElement {
  return (
    <div className="flex gap-1.5 leading-snug">
      <span className="font-medium text-muted-foreground shrink-0">{label}:</span>
      <span className={cn("break-all", mono && "font-mono")}>{value}</span>
    </div>
  );
}

export function ChipList({ items }: { items: string[] }): ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item}
          className="rounded border border-muted bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {item}
        </span>
      ))}
    </div>
  );
}
