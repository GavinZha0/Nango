"use client";

/**
 * JsonView — collapsible, color-coded JSON viewer.
 * Used for displaying MCP tool results and schemas.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface JsonViewProps {
  data: unknown;
  /** Initial expansion depth (default: 2) */
  defaultExpandDepth?: number;
  className?: string;
}

export function JsonView({ data, defaultExpandDepth = 2, className }: JsonViewProps): ReactNode {
  return (
    <div className={cn("font-mono text-xs leading-relaxed", className)}>
      <JsonNode value={data} depth={0} defaultExpandDepth={defaultExpandDepth} />
    </div>
  );
}

// Internal

interface JsonNodeProps {
  value: unknown;
  depth: number;
  defaultExpandDepth: number;
  keyName?: string;
}

function JsonNode({ value, depth, defaultExpandDepth, keyName }: JsonNodeProps): ReactNode {
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

  if (value === null) return <JsonLine keyName={keyName} value="null" className="text-muted-foreground" />;
  if (value === undefined) return <JsonLine keyName={keyName} value="undefined" className="text-muted-foreground" />;

  if (typeof value === "boolean") {
    return <JsonLine keyName={keyName} value={String(value)} className="text-orange-400" />;
  }
  if (typeof value === "number") {
    return <JsonLine keyName={keyName} value={String(value)} className="text-cyan-400" />;
  }
  if (typeof value === "string") {
    return <JsonString keyName={keyName} value={value} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <JsonLine keyName={keyName} value="[]" className="text-muted-foreground" />;
    return (
      <CollapsibleNode
        keyName={keyName}
        label={`Array(${value.length})`}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      >
        {value.map((item, i) => (
          <div key={i} style={{ paddingLeft: 16 }}>
            <JsonNode value={item} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} keyName={String(i)} />
          </div>
        ))}
      </CollapsibleNode>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <JsonLine keyName={keyName} value="{}" className="text-muted-foreground" />;
    return (
      <CollapsibleNode
        keyName={keyName}
        label={`{${entries.length}}`}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      >
        {entries.map(([k, v]) => (
          <div key={k} style={{ paddingLeft: 16 }}>
            <JsonNode value={v} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} keyName={k} />
          </div>
        ))}
      </CollapsibleNode>
    );
  }

  return <JsonLine keyName={keyName} value={String(value)} className="text-foreground" />;
}

function JsonLine({ keyName, value, className }: { keyName?: string; value: string; className?: string }): ReactNode {
  return (
    <div className="flex">
      {keyName !== undefined && (
        <span className="text-purple-400 mr-1">{keyName}:</span>
      )}
      <span className={className}>{value}</span>
    </div>
  );
}

/**
 * Inline string node with click-to-expand for long values.
 *
 * Strings longer than `STRING_PREVIEW_LIMIT` (200 chars) are collapsed by
 * default to keep the JSON tree compact — clicking the value toggles
 * between truncated preview and the full text. The expanded form wraps
 * on whitespace and breaks long unbroken tokens so it never overflows
 * the column horizontally.
 */
const STRING_PREVIEW_LIMIT = 200;

function JsonString({ keyName, value }: { keyName?: string; value: string }): ReactNode {
  const [expanded, setExpanded] = useState<boolean>(false);
  const isLong: boolean = value.length > STRING_PREVIEW_LIMIT;
  const display: string = isLong && !expanded
    ? `"${value.slice(0, STRING_PREVIEW_LIMIT)}…"`
    : `"${value}"`;

  return (
    <div className="flex flex-wrap items-baseline gap-x-1">
      {keyName !== undefined && (
        <span className="text-purple-400 shrink-0">{keyName}:</span>
      )}
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Click to collapse" : `Click to show all ${value.length} characters`}
          className={cn(
            "text-left text-green-400 hover:underline decoration-dotted underline-offset-2 cursor-pointer",
            expanded ? "whitespace-pre-wrap break-all" : "truncate"
          )}
        >
          {display}
          {!expanded && (
            <span className="ml-1 text-muted-foreground/70">
              ({value.length.toLocaleString()} chars)
            </span>
          )}
        </button>
      ) : (
        <span className="text-green-400 break-all">{display}</span>
      )}
    </div>
  );
}

interface CollapsibleNodeProps {
  keyName?: string;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function CollapsibleNode({ keyName, label, expanded, onToggle, children }: CollapsibleNodeProps): ReactNode {
  return (
    <div>
      <button type="button" onClick={onToggle} className="inline-flex items-center gap-0.5 hover:text-foreground text-muted-foreground">
        <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
        {keyName !== undefined && <span className="text-purple-400 mr-1">{keyName}:</span>}
        <span className="text-muted-foreground/60">{label}</span>
      </button>
      {expanded && <div>{children}</div>}
    </div>
  );
}
