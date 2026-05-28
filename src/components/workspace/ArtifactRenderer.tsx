"use client";

import type { ReactNode } from "react";
import type { ArtifactType } from "@/lib/domain/artifact";
import { cn } from "@/lib/utils";
import { FileQuestion } from "lucide-react";
import { MermaidBlock } from "@/components/ui/MermaidBlock";

// types

export interface ArtifactRendererProps {
  id: string;
  type: ArtifactType;
  name?: string;
  content: unknown;
  config?: unknown;
  className?: string;
}

// component

/**
 * ArtifactRenderer — dispatches to the correct renderer based on artifact type.
 */
export function ArtifactRenderer({
  id,
  type,
  name,
  content,
  config,
  className,
}: ArtifactRendererProps): ReactNode {
  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <ArtifactTypeIcon type={type} />
        <span className="truncate text-sm font-medium">{name ?? id}</span>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {type}
        </span>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {renderByType(type, content, config)}
      </div>
    </div>
  );
}

// renderer dispatch

function renderByType(type: ArtifactType, content: unknown, config?: unknown): ReactNode {
  switch (type) {
    case "code":
      return <CodeRenderer content={content} config={config} />;
    case "chart":
      return <ChartPlaceholder content={content} />;
    case "dashboard":
      return <DashboardPlaceholder content={content} />;
    case "html":
      return <HtmlRenderer content={content} />;
    case "image":
      return <ImageRenderer content={content} />;
    case "ppt":
      return <PlaceholderCard label="Presentation" content={content} />;
    case "report":
      return <PlaceholderCard label="Report" content={content} />;
    default:
      return <UnknownArtifact />;
  }
}

// code renderer

interface CodeConfig {
  language?: string;
}

function CodeRenderer({ content, config }: { content: unknown; config?: unknown }) {
  const src = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const lang = (config as CodeConfig | null)?.language ?? "";

  // Mermaid diagrams — render as SVG
  if (lang === "mermaid") {
    return <MermaidBlock code={src} />;
  }

  return (
    <div className="relative h-full">
      {lang && (
        <span className="absolute right-3 top-2 z-10 select-none rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {lang}
        </span>
      )}
      <pre className="h-full overflow-auto rounded bg-muted/60 p-4 text-sm">
        <code className={lang ? `language-${lang}` : ""}>{src}</code>
      </pre>
    </div>
  );
}

// type-specific renderers

function ChartPlaceholder({ content }: { content: unknown }) {
  return (
    <PlaceholderCard
      label="Chart (coming soon)"
      content={content}
      hint="Will render a chart from the provided config."
    />
  );
}

function DashboardPlaceholder({ content }: { content: unknown }) {
  return (
    <PlaceholderCard
      label="Dashboard (coming soon)"
      content={content}
      hint="Will render a multi-panel dashboard."
    />
  );
}

function HtmlRenderer({ content }: { content: unknown }) {
  if (typeof content === "string") {
    return (
      <iframe
        title="HTML artifact"
        srcDoc={content}
        sandbox="allow-scripts"
        className="h-full w-full rounded border"
      />
    );
  }
  return <PlaceholderCard label="HTML" content={content} />;
}

function ImageRenderer({ content }: { content: unknown }) {
  if (typeof content === "string") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={content}
        alt="Artifact image"
        className="max-h-full max-w-full rounded object-contain"
      />
    );
  }
  return <PlaceholderCard label="Image" content={content} />;
}

function UnknownArtifact() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <FileQuestion className="mr-2 h-5 w-5" />
      <span className="text-sm">Unknown artifact type</span>
    </div>
  );
}

// shared fallback

interface PlaceholderCardProps {
  label: string;
  content: unknown;
  hint?: string;
}

function PlaceholderCard({ label, content, hint }: PlaceholderCardProps) {
  return (
    <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <pre className="mt-2 overflow-auto rounded bg-background p-2 text-xs">
        {JSON.stringify(content, null, 2)}
      </pre>
    </div>
  );
}

// icon helper

function ArtifactTypeIcon({ type }: { type: ArtifactType }) {
  const map: Record<ArtifactType, string> = {
    code: "💻",
    chart: "📊",
    dashboard: "🗂️",
    html: "🌐",
    image: "🖼️",
    ppt: "📑",
    report: "📄",
  };
  return <span className="text-base">{map[type] ?? "📄"}</span>;
}
