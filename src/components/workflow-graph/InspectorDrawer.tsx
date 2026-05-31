"use client";

/**
 * InspectorDrawer — per-node detail pane shown to the right of the
 * workflow graph when the user clicks a node card.
 *
 * Layout: header (icon + title + #id chip + Copy / Close buttons),
 * scrollable body composed of per-type sections (description,
 * type-specific "main body", input, output schema, outputs,
 * depends_on), all rendered as a single ScrollArea.
 *
 * V1 design notes:
 *   - The drawer is intentionally NOT a Sheet / Dialog — it lives
 *     inside the workflow panel's horizontal `ResizablePanelGroup`
 *     so the graph stays visible alongside the detail (the user
 *     can compare adjacent nodes by clicking through without
 *     overlapping the chart panel above).
 *   - "Copy as JSON" writes the FULL canonical node (including
 *     bucket-specific fields) to the clipboard. Useful when
 *     asking the LLM to "tweak this node" via chat.
 *   - Code / SQL bodies render as plain `<pre><code>` — a future
 *     highlighter can layer on without a structural change.
 *
 * See docs/workflow-architecture.md. for canonical node shapes
 *      and `src/lib/workflows/spec/schema.ts` for the types.
 */

import { Bot, Code2, Copy, Database, Wrench, X, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { format as formatSql } from "sql-formatter";

import { Button } from "@/components/ui/button";
import { JsonView } from "@/components/ui/json-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type {
  CanonicalAgentNode,
  CanonicalCodeNode,
  CanonicalNode,
  CanonicalSqlNode,
  CanonicalToolNode,
} from "@/lib/workflows/spec/schema";

export interface InspectorDrawerProps {
  node: CanonicalNode;
  onClose: () => void;
}

// ── Visual identity (kept in sync with node-cards.tsx) ───────────────

interface Accent {
  iconBg: string;
  iconFg: string;
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
};

function nodeTitle(node: CanonicalNode): string {
  switch (node.type) {
    case "tool":
      return node.tool;
    case "agent":
      return node.agent;
    case "code":
      return node.language;
    case "sql":
      return node.name ?? node.dataSourceName;
  }
}

// ── Drawer ───────────────────────────────────────────────────────────

export function InspectorDrawer({
  node,
  onClose,
}: InspectorDrawerProps): ReactElement {
  const accent: Accent = ACCENTS[node.type];
  const Icon = accent.Icon;
  const title: string = nodeTitle(node);

  const handleCopy = useCallback(async (): Promise<void> => {
    // Copy the canonical node verbatim. JSON.stringify with 2-space
    // indent so paste-in-issue is readable.
    try {
      await navigator.clipboard.writeText(JSON.stringify(node, null, 2));
      toast.success("Node copied to clipboard");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to copy node",
      );
    }
  }, [node]);

  return (
    <div className="flex h-full flex-col bg-card">
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
            #{node.id} · {node.type}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void handleCopy()}
          title="Copy as JSON"
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

      {/* Body — scrollable per-type sections */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 py-3 text-xs">
          {node.description && (
            <Section title="Description">
              <p className="whitespace-pre-wrap text-foreground">
                {node.description}
              </p>
            </Section>
          )}

          {/* Per-type body — the meaningful "what this node does"
              block (tool name, agent identity, code body, SQL
              query). */}
          {node.type === "tool" && <ToolBody node={node} />}
          {node.type === "agent" && <AgentBody node={node} />}
          {node.type === "code" && <CodeBody node={node} />}
          {node.type === "sql" && <SqlBody node={node} />}

          {/* Universal sections — these apply to every node type
              that has them. */}
          {hasInputMap(node) && (
            <Section title="Input">
              <JsonView data={node.input} defaultExpandDepth={2} />
            </Section>
          )}

          {hasOutputSchema(node) && node.output_schema !== undefined && (
            <Section title="Output schema">
              <JsonView data={node.output_schema} defaultExpandDepth={1} />
            </Section>
          )}

          {node.outputs && node.outputs.length > 0 && (
            <Section title="Outputs">
              <ChipList items={node.outputs} />
            </Section>
          )}

          {node.depends_on.length > 0 && (
            <Section title="Depends on">
              <ChipList items={node.depends_on.map((n) => `#${n}`)} />
            </Section>
          )}

          <RuntimeMetaSection node={node} />
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Per-type body sections ───────────────────────────────────────────

function ToolBody({ node }: { node: CanonicalToolNode }): ReactElement {
  return (
    <Section title="Tool">
      <CodeInline value={node.tool} />
    </Section>
  );
}

function AgentBody({ node }: { node: CanonicalAgentNode }): ReactElement {
  return (
    <>
      <Section title="Agent">
        <CodeInline value={node.agent} />
      </Section>
      <Section title="Agent ID">
        <CodeInline value={node.agentId} subtle />
      </Section>
    </>
  );
}

function CodeBody({ node }: { node: CanonicalCodeNode }): ReactElement {
  return (
    <>
      <Section title="Language">
        <CodeInline value={node.language} />
      </Section>
      <Section title="Code">
        <CodeBlock language={node.language} value={node.code} />
      </Section>
    </>
  );
}

function SqlBody({ node }: { node: CanonicalSqlNode }): ReactElement {
  // Pretty-print the query for readability. The saved spec stores
  // SQL as the LLM emitted it — frequently a single long line.
  // `sql-formatter` reflows that into indented multi-line SQL.
  //
  // `language: "duckdb"` is correct for V1: queries don't run
  // directly against the underlying MariaDB / Vertica data source
  // — they go through DuckDB's scanner extensions, which expose a
  // DuckDB SQL surface that translates downward. The dialect
  // therefore stays "duckdb" regardless of the `dataSourceName`
  // the node points at.
  //
  // `keywordCase: "preserve"` keeps whatever case the LLM emitted
  // (upper / lower / mixed) — formatting reflows the layout
  // without rewriting tokens. Less surprising than forcing UPPER.
  //
  // The try/catch is defensive: sql-formatter is tokenizer-based
  // and tolerant of most inputs, but DuckDB-specific tokens it
  // doesn't recognise could in principle bubble an exception. In
  // that case the user sees the raw query — same as if formatting
  // wasn't applied — instead of an empty drawer.
  const formattedQuery: string = useMemo(() => {
    try {
      return formatSql(node.query, {
        language: "duckdb",
        tabWidth: 2,
        keywordCase: "preserve",
      });
    } catch {
      return node.query;
    }
  }, [node.query]);

  return (
    <>
      <Section title="Data source">
        <CodeInline value={node.dataSourceName} />
      </Section>
      {node.name && (
        <Section title="Dataset name">
          <CodeInline value={node.name} />
        </Section>
      )}
      <Section title="Query">
        <CodeBlock language="sql" value={formattedQuery} />
      </Section>
    </>
  );
}

function RuntimeMetaSection({
  node,
}: {
  node: CanonicalNode;
}): ReactElement | null {
  const rows: Array<[string, string]> = [];
  if (node.timeoutSeconds !== undefined) {
    rows.push(["Timeout", `${node.timeoutSeconds}s`]);
  }
  if (node.retries !== undefined) {
    const { attempts, delaySeconds, backoff } = node.retries;
    rows.push([
      "Retries",
      `${attempts} attempt${attempts === 1 ? "" : "s"}, ${delaySeconds}s delay${backoff !== undefined ? ` (${backoff})` : ""}`,
    ]);
  }
  if (rows.length === 0) return null;
  return (
    <Section title="Runtime">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <span key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate font-mono text-foreground">{v}</dd>
          </span>
        ))}
      </dl>
    </Section>
  );
}

// ── Type-narrowing helpers ───────────────────────────────────────────

/**
 * True when the node carries a generic `input` map (tool / agent —
 * always present; code — optional). SQL has no `input` field.
 */
function hasInputMap(
  node: CanonicalNode,
): node is CanonicalToolNode | CanonicalAgentNode | CanonicalCodeNode {
  if (node.type === "sql") return false;
  if (node.type === "code") return node.input !== undefined;
  return true;
}

/**
 * True when the node may declare `output_schema`. SQL has a fixed
 * `{name, rowCount}` shape — no schema is stored on the canonical
 * node (the executor strips to that shape unconditionally), and
 * agent / code / tool all may carry one.
 */
function hasOutputSchema(
  node: CanonicalNode,
): node is CanonicalToolNode | CanonicalAgentNode | CanonicalCodeNode {
  return node.type !== "sql";
}

// ── Small atoms ──────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  children: ReactNode;
}

function Section({ title, children }: SectionProps): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function CodeInline({
  value,
  subtle = false,
}: {
  value: string;
  subtle?: boolean;
}): ReactElement {
  return (
    <code
      className={cn(
        "block break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px]",
        subtle ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {value}
    </code>
  );
}

interface CodeBlockProps {
  /** Hint for a future syntax highlighter. Stored as a data
   *  attribute so the addition of a highlighter doesn't require
   *  a prop API change. */
  language: string;
  value: string;
}

/**
 * Monospace code block. Currently ships as plain `<pre><code>`;
 * the `rehype-highlight` dependency is already in package.json
 * for when syntax highlighting is wired. The `data-language`
 * attribute is hung on the wrapper so the highlighter has its
 * target to enrich.
 */
function CodeBlock({ language, value }: CodeBlockProps): ReactElement {
  return (
    <pre
      data-language={language}
      className="overflow-x-auto rounded bg-muted px-2.5 py-2 font-mono text-[11px] leading-snug text-foreground"
    >
      <code>{value}</code>
    </pre>
  );
}

function ChipList({ items }: { items: ReadonlyArray<string | number> }): ReactElement {
  // Memoize the rendered chips — items can be a fresh array on
  // every parent render but the slice content rarely changes.
  const chips = useMemo(
    () =>
      items.map((item) => (
        <span
          key={String(item)}
          className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {String(item)}
        </span>
      )),
    [items],
  );
  return <div className="flex flex-wrap gap-1">{chips}</div>;
}
