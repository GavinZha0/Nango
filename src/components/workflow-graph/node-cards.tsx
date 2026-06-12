"use client";

/**
 * Custom ReactFlow node renderers for the workflow graph.
 *
 * One renderer per node bucket:
 *
 *   - `ToolNodeCard`  (amber)   — tool nodes  (`type: "tool"`)
 *   - `AgentNodeCard` (purple)  — agent nodes (`type: "agent"`)
 *   - `CodeNodeCard`  (emerald) — code nodes  (`type: "code"`)
 *   - `SqlNodeCard`   (sky)     — sql nodes   (`type: "sql"`)
 *
 * All four share the same chrome (`NodeCardShell`) and differ
 * only in icon, accent colour, and the per-type summary lines.
 *
 * Layout: fixed 200×100 (kept in sync with `layout.ts` constants).
 * Three logical rows:
 *
 *   Row 1: small coloured icon block + bold title + #id · type chip
 *   Row 2: first input/code summary (truncated)
 *   Row 3: second input/output-schema summary (truncated)
 *
 * Connection handles (the dots from which edges spring) are
 * preserved so dagre + ReactFlow draw edges at the correct
 * positions, but rendered invisible — V1 has no edit affordances,
 * so the user never needs to interact with them. `isConnectable`
 * is `false` everywhere.
 */

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  BarChart3,
  Bot,
  Code2,
  Database,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import type {
  CanonicalAgentNode,
  CanonicalChartNode,
  CanonicalCodeNode,
  CanonicalNode,
  CanonicalSqlNode,
  CanonicalToolNode,
} from "@/lib/workflows/spec/schema";

import { NODE_HEIGHT, NODE_WIDTH, type WorkflowNodeData } from "./layout";

/** ReactFlow Node parameterised with our data payload. */
type WorkflowNode = Node<WorkflowNodeData>;

// ── Visual identity per node type ────────────────────────────────────

interface Accent {
  /** Icon block background (light + dark). */
  iconBg: string;
  /** Icon foreground colour (light + dark). */
  iconFg: string;
  /** lucide icon. */
  Icon: LucideIcon;
}

const ACCENTS: Record<CanonicalNode["type"], Accent> = {
  tool: {
    iconBg: "bg-amber-100 dark:bg-amber-900/40",
    iconFg: "text-amber-700 dark:text-amber-300",
    Icon: Wrench,
  },
  agent: {
    iconBg: "bg-purple-100 dark:bg-purple-900/40",
    iconFg: "text-purple-700 dark:text-purple-300",
    Icon: Bot,
  },
  code: {
    iconBg: "bg-emerald-100 dark:bg-emerald-900/40",
    iconFg: "text-emerald-700 dark:text-emerald-300",
    Icon: Code2,
  },
  sql: {
    iconBg: "bg-sky-100 dark:bg-sky-900/40",
    iconFg: "text-sky-700 dark:text-sky-300",
    Icon: Database,
  },
  chart: {
    iconBg: "bg-rose-100 dark:bg-rose-900/40",
    iconFg: "text-rose-700 dark:text-rose-300",
    Icon: BarChart3,
  },
};

// ── Per-type summary lines ───────────────────────────────────────────

interface NodeSummary {
  title: string;
  line1?: string;
  line2?: string;
}

/**
 * Render `key=value` pairs from a tool/agent `input` map. Skips
 * null/undefined values and truncates over-long stringified values
 * via the parent `truncate` Tailwind class (no inline cropping —
 * CSS handles it more honestly than a manual char-count).
 */
function summarizeInput(
  input: Record<string, unknown> | undefined,
  limit: number,
): string[] {
  if (!input) return [];
  const entries = Object.entries(input).filter(
    ([, v]) => v !== null && v !== undefined,
  );
  return entries.slice(0, limit).map(([k, v]) => {
    const valStr: string = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${valStr}`;
  });
}

function summarizeTool(node: CanonicalToolNode): NodeSummary {
  const [line1, line2] = summarizeInput(node.inputs.arguments, 2);
  return { title: node.inputs.name, line1, line2 };
}

function summarizeAgent(node: CanonicalAgentNode): NodeSummary {
  // Show a snippet of the task (first 60 chars). `context` is
  // operationally interesting but secondary — surface it as line2
  // only when present.
  const task = node.inputs.task;
  const line1 = `task: ${truncateStr(task, 60)}`;
  const context = node.inputs.context;
  const line2: string | undefined =
    context !== undefined && context.length > 0
      ? `context: ${truncateStr(context, 60)}`
      : undefined;
  return { title: node.inputs.name, line1, line2 };
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function summarizeCode(node: CanonicalCodeNode): NodeSummary {
  // Datasets binding is the most operationally relevant input —
  // it's what the engine bind-mounts into the sandbox.
  const datasets: unknown = node.inputs.datasets;
  const datasetList: string[] = Array.isArray(datasets)
    ? datasets.filter((d): d is string => typeof d === "string")
    : [];

  // First non-empty, non-comment line of the snippet — gives a
  // sense of what the code does at a glance. `code_file` nodes
  // surface the file path instead.
  let snippetLine: string | undefined;
  if (node.inputs.code_text !== undefined) {
    snippetLine = node.inputs.code_text
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0 && !s.startsWith("#"));
  } else if (node.inputs.code_file !== undefined) {
    snippetLine = `code_file: ${node.inputs.code_file}`;
  }

  return {
    title: node.inputs.language,
    line1:
      datasetList.length > 0
        ? `datasets: ${datasetList.join(", ")}`
        : undefined,
    line2: snippetLine,
  };
}

function summarizeChart(node: CanonicalChartNode): NodeSummary {
  const dataset = node.inputs.dataset;
  let datasetLine: string;
  if (dataset === undefined) {
    datasetLine = "data: (literal, not refreshable)";
  } else if (Array.isArray(dataset)) {
    datasetLine = `data: ${dataset.length} datasets`;
  } else {
    datasetLine = `data: ${dataset}`;
  }
  return {
    title: `${node.inputs.renderer} chart`,
    // line 1: chart type lifted from the option template if present
    line1: pickChartTypeLine(node.inputs.config),
    // line 2: where the data comes from
    line2: datasetLine,
  };
}

/** Read the first `series[*].type` from an ECharts option
 *  template. Returns `undefined` when no series entry has a
 *  recognisable `type` field. */
function pickChartTypeLine(
  config: Record<string, unknown>,
): string | undefined {
  const series = (config as { series?: unknown }).series;
  if (!Array.isArray(series)) return undefined;
  for (const entry of series) {
    if (entry === null || typeof entry !== "object") continue;
    const t = (entry as { type?: unknown }).type;
    if (typeof t === "string" && t.length > 0) return `series: ${t}`;
  }
  return undefined;
}

function summarizeSql(node: CanonicalSqlNode): NodeSummary {
  // Title prefers the output dataset name (what downstream code /
  // chart nodes ref via @nodes.X.dataset_name) — that's what the
  // workflow actually produces. Fall back to data_source_name
  // when dataset_name is omitted (engine derives a slug at
  // runtime in that case).
  const title: string =
    node.inputs.dataset_name ?? node.inputs.data_source_name;

  // First non-empty line of the SQL — gives a glance-able sense
  // of the query without needing to open the drawer. Strip --
  // SQL line comments at the start of a line; in-line comments
  // (mid-line `--`) are kept as-is since trimming them out is
  // unreliable without a real SQL tokenizer.
  const firstSqlLine: string | undefined = node.inputs.sql_text
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !s.startsWith("--"));

  return {
    title,
    // line 1: data source slug — answers "where does this come from"
    line1: `source: ${node.inputs.data_source_name}`,
    // line 2: SQL snippet — answers "what's the query"
    line2: firstSqlLine,
  };
}

function describeNode(spec: CanonicalNode): NodeSummary {
  switch (spec.type) {
    case "tool":
      return summarizeTool(spec);
    case "agent":
      return summarizeAgent(spec);
    case "code":
      return summarizeCode(spec);
    case "sql":
      return summarizeSql(spec);
    case "chart":
      return summarizeChart(spec);
  }
}

// ── Shared card shell ────────────────────────────────────────────────

interface NodeCardShellProps {
  spec: CanonicalNode;
  selected: boolean;
}

/**
 * Shared visual shell for every node card. Renders the row-1
 * icon+title+chip layout and the row-2/3 muted summary lines.
 * Handles are placed on the left (target) and right (source)
 * edges so dagre/ReactFlow's bezier edges line up cleanly.
 *
 * The handle dots are kept in the DOM (edges need anchors) but
 * styled to be invisible — V1 graphs are read-only.
 */
function NodeCardShell({ spec, selected }: NodeCardShellProps): ReactElement {
  const accent: Accent = ACCENTS[spec.type];
  const { title, line1, line2 } = describeNode(spec);
  const Icon = accent.Icon;

  return (
    <div
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "relative flex flex-col gap-1 rounded-md border bg-card p-2 shadow-sm transition",
        selected
          ? "border-primary shadow-md ring-2 ring-primary/30"
          : "border-border hover:shadow-md",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        // Invisible but positioned — edges anchor here.
        style={{
          width: 8,
          height: 8,
          background: "transparent",
          border: 0,
        }}
      />

      {/* Row 1 — icon + title + #id chip. Type is conveyed by the
          icon's colour and glyph; a textual "TOOL"/"CODE" chip would
          duplicate that information, so the chip is id-only. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded",
            accent.iconBg,
          )}
        >
          <Icon className={cn("h-2.5 w-2.5", accent.iconFg)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
          {title}
        </span>
        <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[9px] font-medium tracking-wide text-muted-foreground">
          #{spec.id}
        </span>
      </div>

      {/* Rows 2-3 — muted summary lines, truncated by CSS */}
      <div className="flex min-h-0 flex-1 flex-col justify-start gap-0.5 overflow-hidden font-mono text-[9px] leading-snug text-muted-foreground">
        {line1 && <div className="truncate">{line1}</div>}
        {line2 && <div className="truncate">{line2}</div>}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{
          width: 8,
          height: 8,
          background: "transparent",
          border: 0,
        }}
      />
    </div>
  );
}

// ── Per-type renderer (registered in WorkflowGraph) ──────────────────

/** Single renderer shared by all node types — the visual
 *  differences (icon, accent) are driven by `spec.type` inside
 *  `NodeCardShell`. Exported individually so ReactFlow's
 *  `nodeTypes` map can register each type key. */
export function WorkflowNodeCard({
  data,
  selected,
}: NodeProps<WorkflowNode>): ReactElement {
  return <NodeCardShell spec={data.spec} selected={selected ?? false} />;
}
