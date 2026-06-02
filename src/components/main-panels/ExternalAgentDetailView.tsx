"use client";

/**
 * ExternalAgentDetailView — read-only detail page for backend agents
 * (agno / mastra / dify entities). Mirrors the visual structure of
 * `BuiltinAgentEditor` (two-column layout with sticky System Prompt
 * on the right) but every field is non-editable: external agents are
 * authored on their upstream platforms, Nango only surfaces them.
 *
 * Fields surfaced (see `docs/a2a-compatibility.md` for the wider
 * mapping):
 *   - Basic:        id, name, description, members (team only)
 *   - Model:        model id / display name / provider
 *   - Capabilities: tool / skill / knowledge counts
 *   - Source:       backend provider + credential
 *   - System Prompt: full `prompt` text in a sticky right column
 *
 * Fields deliberately NOT shown:
 *   - `dbId`  — internal upstream handle, of no value to humans
 *   - `raw`   — vendor-specific payload kept around for adapters;
 *                exposing it would invite users to depend on shapes
 *                that move under their feet
 */

import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  RefreshCw,
  Bot,
  Users,
  Workflow as WorkflowIcon,
  Copy,
  Check,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getProviderLabel } from "@/lib/constants/providers";
import { getEntities } from "@/lib/backends/facade";
import type { EntityDescriptor, EntityKind } from "@/lib/backends/types";
import { useWorkspaceStore } from "@/store/workspace";

interface ExternalAgentDetailViewProps {
  /** The entity to render. Loaded from the workspace store by the
   *  route page, so callers don't have to refetch. */
  entity: EntityDescriptor;
}

// Kind ↔ visuals

const KIND_LABEL: Record<EntityKind, string> = {
  agent: "agent",
  team: "team",
  workflow: "workflow",
};

function KindIcon({ kind, className }: { kind: EntityKind; className?: string }): ReactNode {
  if (kind === "team") return <Users className={className} />;
  if (kind === "workflow") return <WorkflowIcon className={className} />;
  return <Bot className={className} />;
}

// Field row primitives — keep visual rhythm aligned with
// BuiltinAgentEditor's Label/Input rows so users moving between the
// two pages feel "same place".

function FieldRow({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-start gap-2">
      <span className="w-24 shrink-0 pt-1 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-sm">{value}</div>
    </div>
  );
}

function TextValue({ value, mono }: { value?: string | null; mono?: boolean }): ReactNode {
  if (!value) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  return (
    <span className={cn("break-words", mono && "font-mono text-xs")}>{value}</span>
  );
}

function NumberValue({ value }: { value?: number }): ReactNode {
  return (
    <span className="font-mono tabular-nums">{value ?? 0}</span>
  );
}

// Collapsible section heading (matches BuiltinAgentEditor's `Section`
// minus the toggle, since read-only content is always shown).

function SectionHeading({ title }: { title: string }): ReactNode {
  return (
    <div className="px-4 py-2.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="border-b border-border/40">
      <SectionHeading title={title} />
      <div className="space-y-3 px-4 pb-3">{children}</div>
    </div>
  );
}

// Main component

export function ExternalAgentDetailView({ entity }: ExternalAgentDetailViewProps): ReactNode {
  const router = useRouter();
  const { agents, teams, workflows, replaceEntitiesForCredentials } = useWorkspaceStore();

  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  /**
   * Pull the latest entities for this credential and update the
   * workspace store. The store update will re-render any panel
   * showing the same entity. We don't local-refetch the detail
   * because the route page reads from the same store on next render.
   */
  const handleRefresh = useCallback(async () => {
    if (entity.credentialId == null || entity.provider == null) return;
    setRefreshing(true);
    try {
      const result = await getEntities(
        [{ credentialId: entity.credentialId, name: entity.credentialName ?? "", provider: entity.provider }],
        { force: true },
      );
      if (result.data) {
        replaceEntitiesForCredentials(
          new Set([entity.credentialId]),
          result.data,
        );
      }
    } finally {
      setRefreshing(false);
    }
  }, [entity.credentialId, entity.credentialName, entity.provider, replaceEntitiesForCredentials]);

  // After refresh, the route's lookup will pick up the new entity by
  // (credentialId, id) — so we don't need a local entity state copy.
  // The most-recently-resolved entity from the store, fallback to the
  // initial prop while a refresh is in flight.
  const live: EntityDescriptor =
    [...agents, ...teams, ...workflows].find(
      (e) => e.credentialId === entity.credentialId && e.id === entity.id,
    ) ?? entity;

  function handleCopyPrompt(): void {
    if (!live.prompt) return;
    void navigator.clipboard.writeText(live.prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const providerLabel: string = getProviderLabel(live.provider);
  const modelDisplay: string | undefined =
    live.model?.displayName && live.model.displayName !== live.model.id
      ? live.model.displayName
      : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Header — back + kind icon + name + chips + refresh */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => router.push("/agent")}
          aria-label="Back to agent list"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <KindIcon kind={live.kind} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold truncate">{live.name ?? live.id}</h2>
        {live.version && (
          <span className="shrink-0 text-xs font-normal text-muted-foreground/60">
            v{live.version}
          </span>
        )}
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none text-muted-foreground">
          {KIND_LABEL[live.kind]}
        </span>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            aria-label="Refresh from upstream"
            title="Refresh from upstream"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Two-column body — same lg breakpoint + sticky-right pattern
          as `BuiltinAgentEditor`. The right column hosts only the
          system prompt, which is typically the longest piece of content
          on this page. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          {/* LEFT column — Basic / Model / Capabilities / Source */}
          <div className="lg:pr-3">
            <Section title="Basic">
              <FieldRow label="ID" value={<TextValue value={live.id} mono />} />
              <FieldRow label="Name" value={<TextValue value={live.name} />} />
              <FieldRow label="Description" value={<TextValue value={live.description} />} />
              {live.kind === "team" && (
                <FieldRow label="Members" value={<NumberValue value={live.memberCount} />} />
              )}
            </Section>

            <Section title="Model">
              <FieldRow label="Model ID" value={<TextValue value={live.model?.id} mono />} />
              {modelDisplay && (
                <FieldRow label="Display name" value={<TextValue value={modelDisplay} />} />
              )}
              <FieldRow
                label="Provider"
                value={<TextValue value={live.model?.provider ? getProviderLabel(live.model.provider) : undefined} />}
              />
            </Section>

            <Section title="Capabilities">
              <FieldRow label="Tools" value={<NumberValue value={live.toolCount} />} />
              <FieldRow label="Skills" value={<NumberValue value={live.skillCount} />} />
              <FieldRow label="Knowledge" value={<NumberValue value={live.kbCount} />} />
            </Section>

            <Section title="Source">
              <FieldRow label="Backend" value={<TextValue value={providerLabel} />} />
              <FieldRow label="Credential" value={<TextValue value={live.credentialName} />} />
            </Section>
          </div>

          {/* RIGHT column — System Prompt (sticky) */}
          <div className="lg:sticky lg:top-0 lg:self-start lg:border-l lg:border-border/40 lg:pl-3">
            <div className="border-b border-border/40 px-4 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  System Prompt
                </span>
                {live.prompt && (
                  <button
                    type="button"
                    onClick={handleCopyPrompt}
                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Copy prompt to clipboard"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
            </div>
            <div className="px-4 py-3">
              {live.prompt ? (
                <Textarea
                  value={live.prompt}
                  readOnly
                  // Same sizing strategy as the BuiltinAgentEditor
                  // prompt textarea: fixed viewport-relative height,
                  // internal scroll for long prompts, no resize handle
                  // (read-only — there's nothing for the user to grow).
                  className="!field-sizing-fixed h-[calc(100vh-12rem)] min-h-64 resize-none overflow-y-auto font-mono text-xs leading-relaxed"
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  This backend doesn&apos;t expose the agent&apos;s system prompt.
                </p>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
