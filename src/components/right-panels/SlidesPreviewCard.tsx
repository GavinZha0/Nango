"use client";

/**
 * SlidesPreviewCard — inline chat preview for `generate_bento_slides`
 * and `edit_bento_slides` server-tool calls.
 *
 * Compact single-line card: clickable title + (action badge) + approval actions.
 *
 * Responsibilities:
 * 1. Streaming render: inProgress / executing / complete states in compact single-line layout.
 * 2. Outcomes-store update: on complete, upserts or patches Bento slides in `useOutcomeStore`.
 */

import {
  ArrowUpRight,
  Loader2,
  Presentation,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, type ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useOutcomeStore } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";
import { useToolApproval, ToolApprovalButtons, ToolApprovalBadge } from "@/hooks/useToolApproval";
import { normalizeOutcomeId } from "@/lib/outcomes/schema";
import { detectToolResultStatus } from "@/lib/copilot/detect-tool-result-status";
import { WildcardToolRenderer } from "@/components/copilotkit/WildcardToolRenderer";

export interface SlidesPreviewProps {
  name: string;
  toolCallId: string;
  parameters: Record<string, unknown>;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}

export function SlidesPreviewCard(props: SlidesPreviewProps): ReactElement {
  const router = useRouter();
  const select = useOutcomeStore((s) => s.select);
  const outcomes = useOutcomeStore((s) => s.outcomes);

  const isEdit = props.name === "edit_bento_slides";
  const rawOutcomeId = (props.parameters.outcome_id as string | undefined) ?? "";
  const normId = normalizeOutcomeId(rawOutcomeId);

  // Look up existing outcome to derive the canonical title
  const existingOutcome = outcomes.find(
    (o) => normalizeOutcomeId(o.outcomeId) === normId,
  );

  const displayTitle =
    (props.parameters.title as string | undefined) ??
    existingOutcome?.title ??
    (rawOutcomeId.trim().length > 0 ? rawOutcomeId : isEdit ? "Bento Presentation" : "Bento slides");

  const isDeleteAction = isEdit && props.parameters.action === "delete";
  let targetSlideIds: string[] = [];
  if (isDeleteAction) {
    if (Array.isArray(props.parameters.target_slide_ids)) {
      targetSlideIds = props.parameters.target_slide_ids.map(String);
    } else if (typeof props.parameters.target_slide_ids === "string") {
      try {
        const parsed = JSON.parse(props.parameters.target_slide_ids);
        if (Array.isArray(parsed)) targetSlideIds = parsed.map(String);
        else targetSlideIds = [props.parameters.target_slide_ids];
      } catch {
        targetSlideIds = [props.parameters.target_slide_ids];
      }
    }
  }

  // Single-line action badge
  let actionBadge: string | null = null;
  if (isEdit) {
    const action = props.parameters.action as string | undefined;
    if (action === "delete") {
      actionBadge =
        targetSlideIds.length === 1
          ? `deleted ${targetSlideIds[0]}`
          : targetSlideIds.length > 1
            ? `deleted ${targetSlideIds.length} slides`
            : "deleted";
    } else if (action === "replace") {
      actionBadge = "replaced";
    } else if (action === "insert") {
      actionBadge = "inserted";
    }
  }

  const approval = useToolApproval(props.toolCallId, props.name, props.parameters);
  const actions = approval.showButtons ? (
    <ToolApprovalButtons state={approval} />
  ) : (
    <ToolApprovalBadge state={approval} />
  );

  // Side-effect: update Outcomes store upon successful completion
  useEffect(() => {
    if (props.status !== "complete") return;
    if (!props.result || props.result.trim().length === 0) return;

    try {
      const parsed = JSON.parse(props.result) as Record<string, unknown>;
      if (parsed.ok !== true) return;

      if (isEdit) {
        useOutcomeStore.getState().applySlideEditOutcome({
          outcomeId: parsed.outcome_id as string,
          action: parsed.action as "delete" | "replace" | "insert",
          target_slide_ids: parsed.target_slide_ids as string[] | undefined,
          slides: parsed.slides as Array<Record<string, unknown>> | undefined,
          toolCallId: props.toolCallId,
        });
      } else {
        const ws = useWorkspaceStore.getState();
        useOutcomeStore.getState().upsertSlideOutcome({
          outcomeId: parsed.outcome_id as string,
          title: (parsed.title as string) || displayTitle,
          description: parsed.description as string | undefined,
          doc: parsed.doc as Record<string, unknown>,
          toolCallId: props.toolCallId,
          agentId: ws.activeAgentId ?? "system",
          threadId: ws.runtimeThreadId ?? null,
          runId: null,
        });
      }
    } catch {
      // Ignore unparseable results
    }
  }, [props.status, props.result, props.toolCallId, isEdit, displayTitle]);

  const onView = (outcomeId: string): void => {
    router.push("/outcomes");
    select(outcomeId);
  };

  // Pending user approval state
  if (approval.showButtons) {
    if (isDeleteAction) {
      const targetText =
        targetSlideIds.length > 0 ? targetSlideIds.join(", ") : "unspecified";

      return (
        <CardShell variant="error" actions={actions}>
          <div className="flex items-center gap-2 min-w-0">
            <Trash2 className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-sm font-medium text-destructive">
                {displayTitle}
              </span>
              <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-mono font-medium text-destructive">
                Delete slides: [{targetText}]
              </span>
            </div>
          </div>
        </CardShell>
      );
    }

    return (
      <CardShell actions={actions}>
        <div className="flex items-center gap-2 min-w-0">
          <Presentation className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-sm font-medium">{displayTitle}</span>
            {actionBadge && (
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                ({actionBadge})
              </span>
            )}
          </div>
        </div>
      </CardShell>
    );
  }

  // inProgress: streaming parameters
  if (props.status === "inProgress") {
    return (
      <CardShell actions={actions}>
        <div className="flex items-center gap-2 min-w-0">
          <Loader2
            className="h-4 w-4 shrink-0 animate-pulse text-muted-foreground"
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-muted-foreground">
            {displayTitle || (isEdit ? "Editing Bento slides…" : "Generating Bento slides…")}
          </span>
        </div>
      </CardShell>
    );
  }

  // executing: waiting for tool execution
  if (props.status === "executing") {
    return (
      <CardShell actions={actions}>
        <div className="flex items-center gap-2 min-w-0">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" aria-hidden />
          <span className="truncate text-sm font-medium">{displayTitle}</span>
        </div>
      </CardShell>
    );
  }

  // complete: error handling
  const detected = detectToolResultStatus(props.result);
  const isFailed = detected === "failure";

  if (isFailed) {
    return <WildcardToolRenderer {...props} />;
  }

  return (
    <CardShell actions={actions}>
      <div className="flex items-center gap-2 min-w-0">
        <Presentation className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <button
          type="button"
          onClick={() => onView(normId)}
          className="inline-flex cursor-pointer items-center gap-1.5 truncate text-sm font-medium text-amber-600 hover:text-amber-700 hover:underline dark:text-amber-400 dark:hover:text-amber-300"
          aria-label={`View ${displayTitle} in Outcomes`}
        >
          <span className="truncate">{displayTitle}</span>
          {actionBadge && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              ({actionBadge})
            </span>
          )}
          <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden />
        </button>
      </div>
    </CardShell>
  );
}

function CardShell({
  variant = "default",
  children,
  actions,
}: {
  variant?: "default" | "error";
  children: React.ReactNode;
  actions?: React.ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "my-1.5 flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 min-w-0",
        variant === "error" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex items-center flex-1 min-w-0">
        {children}
      </div>
      {actions && <div className="ml-auto shrink-0 flex items-center">{actions}</div>}
    </div>
  );
}
