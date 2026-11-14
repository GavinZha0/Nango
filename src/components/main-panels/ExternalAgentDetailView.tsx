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

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
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
import type { EntityDescriptor, EntityKind } from "@/lib/backends/types";
import { useWorkspaceStore } from "@/store/workspace";

interface ExternalAgentDetailViewProps {
  /** The entity to render. Loaded from the workspace store by the
   *  route page, so callers don't have to refetch. */
  entity: EntityDescriptor;
}

// Kind ↔ visuals

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

function CapabilityMark({ supported }: { supported?: boolean }): ReactNode {
  return (
    <span
      className={cn(
        "text-xs font-medium",
        supported
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-500 dark:text-red-400",
      )}
      aria-label={supported ? "Supported" : "Not supported"}
    >
      {supported ? "✓" : "✗"}
    </span>
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
  const { agents, teams, workflows } = useWorkspaceStore();

  const [copied, setCopied] = useState<boolean>(false);

  // After refresh, the route's lookup will pick up the new entity by
  // (credentialId, id) — so we don't need a local entity state copy.
  // The most-recently-resolved entity from the store, fallback to the
  // initial prop while a refresh is in flight.
  const live: EntityDescriptor =
    [...agents, ...teams, ...workflows].find(
      (e) => e.credentialId === entity.credentialId && e.id === entity.id,
    ) ?? entity;

  const isA2a = live.provider === "a2a";
  const rightPanelText = isA2a
    ? (live.raw ? JSON.stringify(live.raw, null, 2) : "")
    : (live.prompt ?? "");

  function handleCopyRightPanel(): void {
    if (!rightPanelText) return;
    void navigator.clipboard.writeText(rightPanelText).then(() => {
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
              {isA2a && live.providerInfo?.organization && (
                <FieldRow
                  label="Provider"
                  value={
                    <TextValue
                      value={
                        live.providerInfo.url
                          ? `${live.providerInfo.organization} (${live.providerInfo.url})`
                          : live.providerInfo.organization
                      }
                    />
                  }
                />
              )}
            </Section>

            {isA2a ? (
              <>
                <Section title="Interface Capabilities">
                  <FieldRow
                    label="Streaming"
                    value={<CapabilityMark supported={live.capabilities?.streaming} />}
                  />
                  <FieldRow
                    label="Notifications"
                    value={<CapabilityMark supported={live.capabilities?.pushNotifications} />}
                  />
                  <FieldRow
                    label="Extended Card"
                    value={<CapabilityMark supported={live.capabilities?.extendedAgentCard} />}
                  />
                </Section>

                <Section title="Skills">
                  {live.skills && live.skills.length > 0 ? (
                    <div className="space-y-2">
                      {live.skills.map((skill) => (
                        <div key={skill.id} className="rounded-md border border-border/50 p-2.5">
                          {skill.description && (
                            <p className="text-xs text-muted-foreground">{skill.description}</p>
                          )}
                          {skill.tags && skill.tags.length > 0 && (
                            <div className={cn("flex flex-wrap justify-end gap-1", skill.description && "mt-1.5")}>
                              {skill.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground/60">—</span>
                  )}
                </Section>
              </>
            ) : (
              <>
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
              </>
            )}

            <Section title="Source">
              <FieldRow label="Backend" value={<TextValue value={providerLabel} />} />
              {isA2a && live.protocolVersion && (
                <FieldRow label="Protocol" value={<TextValue value={live.protocolVersion} mono />} />
              )}
              <FieldRow label="Credential" value={<TextValue value={live.credentialName} />} />
            </Section>
          </div>

          {/* RIGHT column — System Prompt or A2A Agent Card (sticky) */}
          <div className="lg:sticky lg:top-0 lg:self-start lg:border-l lg:border-border/40 lg:pl-3">
            <div className="border-b border-border/40 px-4 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {isA2a ? "Agent Card" : "System Prompt"}
                </span>
                {rightPanelText && (
                  <button
                    type="button"
                    onClick={handleCopyRightPanel}
                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={isA2a ? "Copy agent card to clipboard" : "Copy prompt to clipboard"}
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
            </div>
            <div className="px-4 py-3">
              {rightPanelText ? (
                <Textarea
                  value={rightPanelText}
                  readOnly
                  // Same sizing strategy as the BuiltinAgentEditor
                  // prompt textarea: fixed viewport-relative height,
                  // internal scroll for long content, no resize handle.
                  className="!field-sizing-fixed h-[calc(100vh-12rem)] min-h-64 resize-none overflow-y-auto font-mono text-xs leading-relaxed"
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {isA2a
                    ? "No Agent Card payload available."
                    : "This backend doesn\u0027t expose the agent\u0027s system prompt."}
                </p>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
